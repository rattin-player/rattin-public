import { SelectedCandidateInfo } from '../lib/types';
import { PeerConnection } from '../lib/index';
import RTCDataChannel from './RTCDataChannel.js';
import { RTCDataChannelEvent } from './Events.js';
import RTCCertificate from './RTCCertificate.js';

interface RTCConfiguration extends globalThis.RTCConfiguration {
    peerIdentity?: string;
    peerConnection?: PeerConnection;
}
declare class RTCPeerConnection extends EventTarget implements globalThis.RTCPeerConnection {
    #private;
    static generateCertificate(): Promise<RTCCertificate>;
    onconnectionstatechange: globalThis.RTCPeerConnection['onconnectionstatechange'];
    ondatachannel: ((this: globalThis.RTCPeerConnection, ev: RTCDataChannelEvent) => any) | null;
    onicecandidate: globalThis.RTCPeerConnection['onicecandidate'];
    onicecandidateerror: globalThis.RTCPeerConnection['onicecandidateerror'];
    oniceconnectionstatechange: globalThis.RTCPeerConnection['oniceconnectionstatechange'];
    onicegatheringstatechange: globalThis.RTCPeerConnection['onicegatheringstatechange'];
    onnegotiationneeded: globalThis.RTCPeerConnection['onnegotiationneeded'];
    onsignalingstatechange: globalThis.RTCPeerConnection['onsignalingstatechange'];
    ontrack: globalThis.RTCPeerConnection['ontrack'];
    private _checkConfiguration;
    setConfiguration(config: globalThis.RTCConfiguration): void;
    constructor(config?: RTCConfiguration);
    get ext_maxDataChannelId(): number;
    get ext_maxMessageSize(): number;
    get ext_localCandidates(): globalThis.RTCIceCandidate[];
    get ext_remoteCandidates(): globalThis.RTCIceCandidate[];
    selectedCandidatePair(): {
        local: SelectedCandidateInfo;
        remote: SelectedCandidateInfo;
    } | null;
    get canTrickleIceCandidates(): boolean | null;
    get connectionState(): globalThis.RTCPeerConnectionState;
    get iceConnectionState(): globalThis.RTCIceConnectionState;
    get iceGatheringState(): globalThis.RTCIceGatheringState;
    get currentLocalDescription(): globalThis.RTCSessionDescription;
    get currentRemoteDescription(): globalThis.RTCSessionDescription;
    get localDescription(): globalThis.RTCSessionDescription;
    get pendingLocalDescription(): globalThis.RTCSessionDescription;
    get pendingRemoteDescription(): globalThis.RTCSessionDescription;
    get remoteDescription(): globalThis.RTCSessionDescription;
    get sctp(): globalThis.RTCSctpTransport;
    get signalingState(): globalThis.RTCSignalingState;
    addIceCandidate(candidate?: globalThis.RTCIceCandidateInit | null): Promise<void>;
    addTrack(_track: any, ..._streams: any[]): globalThis.RTCRtpSender;
    addTransceiver(_trackOrKind: any, _init: any): globalThis.RTCRtpTransceiver;
    close(): void;
    createAnswer(): Promise<globalThis.RTCSessionDescriptionInit | any>;
    createDataChannel(label: string, opts?: globalThis.RTCDataChannelInit): RTCDataChannel;
    createOffer(): Promise<globalThis.RTCSessionDescriptionInit | any>;
    getConfiguration(): globalThis.RTCConfiguration;
    getReceivers(): globalThis.RTCRtpReceiver[];
    getSenders(): globalThis.RTCRtpSender[];
    getStats(): Promise<globalThis.RTCStatsReport> | any;
    getTransceivers(): globalThis.RTCRtpTransceiver[];
    removeTrack(): void;
    restartIce(): Promise<void>;
    setLocalDescription(description: globalThis.RTCSessionDescriptionInit): Promise<void>;
    setRemoteDescription(description: globalThis.RTCSessionDescriptionInit): Promise<void>;
}

export { RTCPeerConnection as default };
