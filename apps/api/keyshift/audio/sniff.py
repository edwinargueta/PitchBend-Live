"""Magic-byte sniffing for uploads (ARCHITECTURE.md §7, ADR 0005 §11).

The first gate: the file's own bytes must look like mp3, wav, mp4/m4a, aac, flac or
ogg. The client's filename extension and Content-Type are ignored. ffprobe decides next.
"""

SNIFF_BYTES = 16


def sniff_audio(head: bytes) -> str | None:
    """Return the container family the leading bytes suggest, or ``None``."""
    if head.startswith(b"ID3"):
        return "mp3"  # ID3v2 tag in front of MPEG audio (occasionally other codecs)
    if head[:4] in (b"RIFF", b"RF64") and head[8:12] == b"WAVE":
        return "wav"
    if head.startswith(b"fLaC"):
        return "flac"
    if head.startswith(b"OggS"):
        return "ogg"
    if head[4:8] == b"ftyp":
        return "mp4"
    if head.startswith(b"ADIF"):
        return "aac"
    if len(head) >= 2 and head[0] == 0xFF and head[1] & 0xE0 == 0xE0:
        # Frame sync. Layer bits 00 mean ADTS AAC; anything else is MPEG audio (mp3).
        return "aac" if head[1] & 0x06 == 0 else "mp3"
    return None
