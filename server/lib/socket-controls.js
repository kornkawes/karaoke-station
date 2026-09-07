import {
  isLoopbackAddress,
  isSameOriginRequest
} from "../middleware/access.js";

export function disconnectPartyGuests(partyIo) {
  if (!partyIo) return 0;
  const connectedCount = partyIo.engine?.clientsCount ?? 0;
  partyIo.disconnectSockets(true);
  return connectedCount;
}

export function isSameOriginSocketRequest(request) {
  return isSameOriginRequest(request);
}

export function isHostSocketRequest(request) {
  return (
    isLoopbackAddress(request?.socket?.remoteAddress) &&
    isSameOriginRequest(request, { loopbackOnly: true })
  );
}

export function allowSameOriginSocketRequest(request, callback) {
  callback(null, isSameOriginSocketRequest(request));
}

export function allowHostSocketRequest(request, callback) {
  callback(null, isHostSocketRequest(request));
}

export function partyListenerLogMessage(port, addressCount) {
  const count = Number.isInteger(addressCount) && addressCount >= 0 ? addressCount : 0;
  return `Party Mode active on LAN port ${port} (${count} address${count === 1 ? "" : "es"})`;
}
