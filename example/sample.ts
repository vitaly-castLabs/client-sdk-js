//@ts-ignore
import {rtcDrmGetVersion, rtcDrmConfigure, rtcDrmOnTrack, rtcDrmEnvironments} from './rtc-drm-transform.min.js';
import {
  ConnectionQuality,
  DisconnectReason,
  LocalAudioTrack,
  LogLevel,
  Participant,
  ParticipantEvent,
  RemoteParticipant,
  Room,
  RoomConnectOptions,
  RoomEvent,
  RoomOptions,
  TrackPublication,
  VideoPresets,
  createAudioAnalyser,
  setLogLevel
} from '../src/index';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let currentRoom: Room | undefined;

let startTime: number;

const searchParams = new URLSearchParams(window.location.search);
const storedUrl = searchParams.get('url') ?? 'ws://localhost:7880';
const storedToken = searchParams.get('token') ?? '';
(<HTMLInputElement>$('url')).value = storedUrl;
(<HTMLInputElement>$('token')).value = storedToken;

// DRMtoday
const merchant = searchParams.get('merchant') ?? '';
const storedKeyId = searchParams.get('keyid') ?? '00000000000000000000000000000001';
const storedIV = searchParams.get('iv') ?? 'd5fbd6b82ed93e4ef98ae40931ee33b7';
(<HTMLInputElement>$('keyid')).value = storedKeyId;
(<HTMLInputElement>$('iv')).value = storedIV;

function hexStringToUint8Array(hexString: string) {
  if (hexString.length % 2 !== 0) {
    console.error('hexStringToUint8Array: invalid hex string');
    return null;
  }

  const array = new Uint8Array(hexString.length / 2);
  for (let i = 0; i < hexString.length; i += 2) {
    const byte = parseInt(hexString.substr(i, 2), 16);
    if (isNaN(byte)) {
      console.error('hexStringToUint8Array: invalid hex string');
      return null;
    }
    array[i / 2] = byte;
  }
  return array;
}

function updateSearchParams(url: string, token: string) {
  const params = new URLSearchParams({ merchant, url, token });
  window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
}

// handles actions from the HTML
const appActions = {
  connectWithFormInput: async () => {
    const url = (<HTMLInputElement>$('url')).value;
    const token = (<HTMLInputElement>$('token')).value;
    const simulcast = false;
    const dynacast = false;
    const forceTURN = false;
    const adaptiveStream = false;
    const shouldPublish = false;
    const autoSubscribe = true;

    setLogLevel(LogLevel.debug);
    updateSearchParams(url, token);

    console.log('rtcDrmGetVersion:', rtcDrmGetVersion());
    const keyId = hexStringToUint8Array((<HTMLInputElement>$('keyid')).value);
    const iv = hexStringToUint8Array((<HTMLInputElement>$('iv')).value);
    const drmConfig = {
      merchant,
      environment: rtcDrmEnvironments.Staging,

      videoElement: $('remote-video'),
      audioElement: $('remote-audio'),

      video: {codec: 'H264', encryption: 'cbcs', keyId, iv},
      audio: {codec: 'opus', encryption: 'clear'}
    };
    try {
      rtcDrmConfigure(drmConfig);
    }
    catch (err) {
      alert(`DRM initialization error: ${err}`);
    }

    const roomOpts: RoomOptions = {
      adaptiveStream,
      dynacast,
      publishDefaults: {
        simulcast,
        videoSimulcastLayers: [VideoPresets.h90, VideoPresets.h216],
        videoCodec: 'h264',
        backupCodec: false,
        dtx: true,
        red: true,
        forceStereo: false
      },
      videoCaptureDefaults: {
        resolution: VideoPresets.h720.resolution,
      }
    };

    const connectOpts: RoomConnectOptions = {
      autoSubscribe: autoSubscribe,
      rtcConfig: {
        encodedInsertableStreams: true,
        iceTransportPolicy: forceTURN ? 'relay' : 'all'
      }
    };
    await appActions.connectToRoom(url, token, roomOpts, connectOpts, shouldPublish);
  },

  connectToRoom: async (
    url: string,
    token: string,
    roomOptions?: RoomOptions,
    connectOptions?: RoomConnectOptions,
    shouldPublish?: boolean,
  ): Promise<Room | undefined> => {
    const room = new Room(roomOptions);

    startTime = Date.now();
    await room.prepareConnection(url, token);
    const prewarmTime = Date.now() - startTime;
    appendLog(`prewarmed connection in ${prewarmTime}ms`);

    room
      .on(RoomEvent.ParticipantConnected, participantConnected)
      .on(RoomEvent.ParticipantDisconnected, participantDisconnected)
      .on(RoomEvent.Disconnected, handleRoomDisconnect)
      .on(RoomEvent.Reconnecting, () => appendLog('Reconnecting to room'))
      .on(RoomEvent.Reconnected, async () => {
        appendLog(
          'Successfully reconnected. server',
          await room.engine.getConnectedServerAddress(),
        );
      })
      .on(RoomEvent.LocalTrackPublished, (pub) => {
        const track = pub.track as LocalAudioTrack;

        if (track instanceof LocalAudioTrack) {
          const { calculateVolume } = createAudioAnalyser(track);

          setInterval(() => {
            $('local-volume')?.setAttribute('value', calculateVolume().toFixed(4));
          }, 200);
        }
      })
      .on(
        RoomEvent.ConnectionQualityChanged,
        (quality: ConnectionQuality, participant?: Participant) => {
          appendLog('connection quality changed', participant?.identity, quality);
        },
      )
      .on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
        appendLog('subscribed to track', pub.trackSid, participant.identity, track);
        // rtcDrmOntrack expects the original RTCPeerConnection track event,
        // of which track, receiver and streams are utilized
        let event = { track, receiver: track.receiver, streams: [track.mediaStream] };
        rtcDrmOnTrack(event);
      })
      .on(RoomEvent.TrackUnsubscribed, (_, pub, participant) => {
        appendLog('unsubscribed from track', pub.trackSid);
      })
      .on(RoomEvent.SignalConnected, async () => {
        const signalConnectionTime = Date.now() - startTime;
        appendLog(`signal connection established in ${signalConnectionTime}ms`);
      })
      .on(RoomEvent.TrackStreamStateChanged, (pub, streamState, participant) => {
        appendLog(
          `stream state changed for ${pub.trackSid} (${
            participant.identity
          }) to ${streamState.toString()}`,
        );
      });

    try {
      await room.connect(url, token, connectOptions);
      const elapsed = Date.now() - startTime;
      appendLog(
        `successfully connected to ${room.name} in ${Math.round(elapsed)}ms`,
        await room.engine.getConnectedServerAddress(),
      );
    } catch (error: any) {
      let message: any = error;
      if (error.message) {
        message = error.message;
      }
      appendLog('could not connect:', message);
      return;
    }
    currentRoom = room;
    window.currentRoom = room;
    setButtonsForState(true);

    room.participants.forEach((participant) => {
      participantConnected(participant);
    });
    participantConnected(room.localParticipant);

    return room;
  },

  disconnectRoom: () => {
    if (currentRoom) {
      currentRoom.disconnect();
    }
  }
};

declare global {
  interface Window {
    currentRoom: any;
    appActions: typeof appActions;
  }
}

window.appActions = appActions;

// --------------------------- event handlers ------------------------------- //

function participantConnected(participant: Participant) {
  appendLog('participant', participant.identity, 'connected', participant.metadata);
  console.log('tracks', participant.tracks);
  participant
    .on(ParticipantEvent.TrackMuted, (pub: TrackPublication) => {
      appendLog('track was muted', pub.trackSid, participant.identity);
    })
    .on(ParticipantEvent.TrackUnmuted, (pub: TrackPublication) => {
      appendLog('track was unmuted', pub.trackSid, participant.identity);
    })
    .on(ParticipantEvent.IsSpeakingChanged, () => {
    })
    .on(ParticipantEvent.ConnectionQualityChanged, () => {
    });
}

function clearMediaElements() {
  (<HTMLVideoElement>$('remote-video')).srcObject = null;
  (<HTMLAudioElement>$('remote-audio')).srcObject = null;
}

function participantDisconnected(participant: RemoteParticipant) {
  appendLog('participant', participant.sid, 'disconnected');
  clearMediaElements();
}

function handleRoomDisconnect(reason?: DisconnectReason) {
  if (!currentRoom) return;
  appendLog('disconnected from room', { reason });

  clearMediaElements();
  setButtonsForState(false);

  currentRoom = undefined;
  window.currentRoom = undefined;
}

function setButtonsForState(connected: boolean) {
  const connectedSet = ['disconnect-room-button'];
  const disconnectedSet = ['connect-button'];

  const toRemove = connected ? connectedSet : disconnectedSet;
  const toAdd = connected ? disconnectedSet : connectedSet;

  toRemove.forEach((id) => $(id)?.removeAttribute('disabled'));
  toAdd.forEach((id) => $(id)?.setAttribute('disabled', 'true'));
}

function appendLog(...args: any[]) {
  const logger = $('log')!;
  for (let i = 0; i < arguments.length; i += 1) {
    if (typeof args[i] === 'object') {
      logger.innerHTML += `${
        JSON && JSON.stringify ? JSON.stringify(args[i], undefined, 2) : args[i]
      } `;
    } else {
      logger.innerHTML += `${args[i]} `;
    }
  }
  logger.innerHTML += '\n';
  (() => {
    logger.scrollTop = logger.scrollHeight;
  })();
}
