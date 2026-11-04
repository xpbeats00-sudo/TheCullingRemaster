"""Make a copy of Func.Client.dll whose ClientWeb URL points at the local server.

usage: python patch_client_dll.py <Func.Client.dll> <out.dll> [url]
"""
import sys

OLD = "https://theculling.atch.ooo/api"

def main(src, out, url="http://127.0.0.1:8000/api"):
    data = bytearray(open(src, "rb").read())
    old = OLD.encode("utf-16le")
    if len(url) > len(OLD):
        sys.exit("url must be at most %d characters" % len(OLD))
    i = data.find(old)
    if i < 0:
        sys.exit("original URL not found in %s (already patched or different build?)" % src)
    new = url.encode("utf-16le").ljust(len(old), b"\0")
    data[i:i + len(old)] = new
    open(out, "wb").write(data)
    print("patched URL at offset 0x%X -> %s" % (i, url))

if __name__ == "__main__":
    main(*sys.argv[1:])
