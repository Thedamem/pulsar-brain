"""ESPHome Native API plaintext framing and protobuf helpers.

Wire format of a plaintext frame (no Noise)::

    b"\\x00" | varint(payload length) | varint(message type) | payload

Message ids come from ``api.proto`` ``option (id)`` and match the ones pulsar
0.5.3 implements in ``satellite/crates/pulsar-esphome/src/server.rs`` (``mod
msg``).  Protobuf classes are reused from :mod:`aioesphomeapi.api_pb2` instead
of a vendored copy, so the mock speaks exactly the protocol the bridge client
does.
"""

from __future__ import annotations

import asyncio

from aioesphomeapi import api_pb2
from google.protobuf.json_format import MessageToDict
from google.protobuf.message import Message

MAX_FRAME_SIZE = 65535

# api.proto option (id) values.  Keep in sync with api.proto if aioesphomeapi is upgraded.
MSG_HELLO_REQUEST = 1
MSG_HELLO_RESPONSE = 2
MSG_DISCONNECT_REQUEST = 5
MSG_DISCONNECT_RESPONSE = 6
MSG_PING_REQUEST = 7
MSG_PING_RESPONSE = 8
MSG_DEVICE_INFO_REQUEST = 9
MSG_DEVICE_INFO_RESPONSE = 10
MSG_LIST_ENTITIES_REQUEST = 11
MSG_LIST_ENTITIES_DONE_RESPONSE = 19
MSG_SUBSCRIBE_STATES_REQUEST = 20
MSG_SUBSCRIBE_LOGS_REQUEST = 28
MSG_SUBSCRIBE_VOICE_ASSISTANT_REQUEST = 89
MSG_VOICE_ASSISTANT_REQUEST = 90
MSG_VOICE_ASSISTANT_RESPONSE = 91
MSG_VOICE_ASSISTANT_EVENT_RESPONSE = 92
MSG_VOICE_ASSISTANT_AUDIO = 106
MSG_VOICE_ASSISTANT_ANNOUNCE_REQUEST = 119
MSG_VOICE_ASSISTANT_ANNOUNCE_FINISHED = 120
MSG_VOICE_ASSISTANT_CONFIGURATION_REQUEST = 121
MSG_VOICE_ASSISTANT_CONFIGURATION_RESPONSE = 122
MSG_DEVICE_CAPABILITIES_REQUEST = 149
MSG_DEVICE_CAPABILITIES_RESPONSE = 150

MESSAGE_IDS: dict[str, int] = {
    "HelloRequest": MSG_HELLO_REQUEST,
    "HelloResponse": MSG_HELLO_RESPONSE,
    "DisconnectRequest": MSG_DISCONNECT_REQUEST,
    "DisconnectResponse": MSG_DISCONNECT_RESPONSE,
    "PingRequest": MSG_PING_REQUEST,
    "PingResponse": MSG_PING_RESPONSE,
    "DeviceInfoRequest": MSG_DEVICE_INFO_REQUEST,
    "DeviceInfoResponse": MSG_DEVICE_INFO_RESPONSE,
    "ListEntitiesRequest": MSG_LIST_ENTITIES_REQUEST,
    "ListEntitiesDoneResponse": MSG_LIST_ENTITIES_DONE_RESPONSE,
    "SubscribeStatesRequest": MSG_SUBSCRIBE_STATES_REQUEST,
    "SubscribeLogsRequest": MSG_SUBSCRIBE_LOGS_REQUEST,
    "SubscribeVoiceAssistantRequest": MSG_SUBSCRIBE_VOICE_ASSISTANT_REQUEST,
    "VoiceAssistantRequest": MSG_VOICE_ASSISTANT_REQUEST,
    "VoiceAssistantResponse": MSG_VOICE_ASSISTANT_RESPONSE,
    "VoiceAssistantEventResponse": MSG_VOICE_ASSISTANT_EVENT_RESPONSE,
    "VoiceAssistantAudio": MSG_VOICE_ASSISTANT_AUDIO,
    "VoiceAssistantAnnounceRequest": MSG_VOICE_ASSISTANT_ANNOUNCE_REQUEST,
    "VoiceAssistantAnnounceFinished": MSG_VOICE_ASSISTANT_ANNOUNCE_FINISHED,
    "VoiceAssistantConfigurationRequest": MSG_VOICE_ASSISTANT_CONFIGURATION_REQUEST,
    "VoiceAssistantConfigurationResponse": MSG_VOICE_ASSISTANT_CONFIGURATION_RESPONSE,
    "DeviceCapabilitiesRequest": MSG_DEVICE_CAPABILITIES_REQUEST,
    "DeviceCapabilitiesResponse": MSG_DEVICE_CAPABILITIES_RESPONSE,
}

ID_TO_MESSAGE: dict[int, type[Message]] = {
    message_id: getattr(api_pb2, name) for name, message_id in MESSAGE_IDS.items()
}
MESSAGE_TO_ID: dict[type[Message], int] = {
    getattr(api_pb2, name): message_id for name, message_id in MESSAGE_IDS.items()
}

_VA_EVENT_NAMES: dict[int, str] = {
    value.number: value.name
    for value in api_pb2.DESCRIPTOR.enum_types_by_name["VoiceAssistantEvent"].values
}


class ProtocolError(Exception):
    """Malformed or unsupported data on the ESPHome API socket."""


async def _read_exactly(reader: asyncio.StreamReader, count: int) -> bytes | None:
    """Read exactly ``count`` bytes; None on a clean EOF before the first byte."""
    if count == 0:
        return b""
    try:
        return await reader.readexactly(count)
    except asyncio.IncompleteReadError as err:
        if not err.partial:
            return None
        raise ProtocolError(f"connection closed in the middle of a frame ({len(err.partial)}/{count} bytes)") from err


async def _read_varuint(reader: asyncio.StreamReader) -> int:
    result = 0
    shift = 0
    while True:
        chunk = await _read_exactly(reader, 1)
        if chunk is None:
            raise ProtocolError("connection closed inside a varint")
        byte = chunk[0]
        result |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return result
        shift += 7
        if shift > 28:
            raise ProtocolError("varint longer than 4 bytes")


def encode_varuint(value: int) -> bytes:
    if value < 0:
        raise ValueError("varuint cannot be negative")
    encoded = bytearray()
    while True:
        chunk = value & 0x7F
        value >>= 7
        if value:
            encoded.append(chunk | 0x80)
        else:
            encoded.append(chunk)
            return bytes(encoded)


def encode_frame(message_type: int, payload: bytes = b"") -> bytes:
    return b"\x00" + encode_varuint(len(payload)) + encode_varuint(message_type) + payload


def encode_message(message: Message) -> bytes:
    message_type = MESSAGE_TO_ID.get(type(message))
    if message_type is None:
        raise ProtocolError(f"no ESPHome message id registered for {type(message).__name__}")
    return encode_frame(message_type, message.SerializeToString())


async def read_frame(reader: asyncio.StreamReader) -> tuple[int, bytes] | None:
    """Read one frame; returns (message type, payload) or None on clean EOF."""
    preamble = await _read_exactly(reader, 1)
    if preamble is None:
        return None
    if preamble != b"\x00":
        raise ProtocolError(f"invalid preamble 0x{preamble[0]:02x} (encrypted connections are not supported)")
    length = await _read_varuint(reader)
    if length > MAX_FRAME_SIZE:
        raise ProtocolError(f"frame length {length} exceeds {MAX_FRAME_SIZE} bytes")
    message_type = await _read_varuint(reader)
    payload = await _read_exactly(reader, length) if length else b""
    if payload is None:
        raise ProtocolError("connection closed before the frame payload")
    return message_type, payload


def decode_message(message_type: int, payload: bytes) -> Message | None:
    """Decode a known message; None for ids the mock does not care about."""
    message_class = ID_TO_MESSAGE.get(message_type)
    if message_class is None:
        return None
    message = message_class()
    try:
        message.ParseFromString(payload)
    except Exception as err:  # protobuf raises DecodeError
        raise ProtocolError(f"cannot decode {message_class.__name__}: {err}") from err
    return message


def message_to_dict(message: Message) -> dict:
    """JSON-friendly dict of a protobuf message, for the events journal."""
    return MessageToDict(message, preserving_proto_field_name=True)


def va_event_raw_name(event_type: int) -> str:
    return _VA_EVENT_NAMES.get(event_type, f"UNKNOWN_{event_type}")


def va_event_short_name(event_type: int) -> str:
    """``VOICE_ASSISTANT_STT_VAD_START`` -> ``stt_vad_start``, matching contract wording."""
    name = va_event_raw_name(event_type)
    prefix = "VOICE_ASSISTANT_"
    if name.startswith(prefix):
        name = name[len(prefix) :]
    return name.lower()
