"""UE4 FName hashes stored next to each name-table entry in cooked packages
(UE 4.15: NonCasePreservingHash = Strihash_DEPRECATED & 0xFFFF,
CasePreservingHash = StrCrc32 & 0xFFFF)."""


def _reflected_table():
    table = []
    for i in range(256):
        c = i
        for _ in range(8):
            c = (c >> 1) ^ 0xEDB88320 if c & 1 else c >> 1
        table.append(c)
    return table


def _msb_table():
    table = []
    for i in range(256):
        c = i << 24
        for _ in range(8):
            c = ((c << 1) ^ 0x04C11DB7) & 0xFFFFFFFF if c & 0x80000000 else (c << 1) & 0xFFFFFFFF
        table.append(c)
    return table


_CRC = _reflected_table()
_CRC_DEPRECATED = _msb_table()


def str_crc32(s):
    crc = 0xFFFFFFFF
    for ch in s:
        c = ord(ch)
        for _ in range(4):  # each TCHAR fed as 4 bytes
            crc = (crc >> 8) ^ _CRC[(crc ^ c) & 0xFF]
            c >>= 8
    return ~crc & 0xFFFFFFFF


def strihash_deprecated(s):
    h = 0
    for ch in s:
        b = ord(ch.upper()) & 0xFF
        h = ((h >> 8) & 0x00FFFFFF) ^ _CRC_DEPRECATED[(h ^ b) & 0xFF]
    return h


def name_hashes(s):
    return strihash_deprecated(s) & 0xFFFF, str_crc32(s) & 0xFFFF
