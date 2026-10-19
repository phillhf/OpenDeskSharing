"""
OpenDeskSharing – HTTPS-Zertifikate ohne Zusatzprogramme.

Erzeugt beim ersten Start eine eigene kleine Zertifizierungsstelle (Stammzertifikat, 20 Jahre gültig)
und damit ein Serverzertifikat für die Namen und Adressen dieses Rechners. Wird das Stammzertifikat
einmal auf den Arbeitsplätzen als vertrauenswürdig eingetragen (z. B. per Gruppenrichtlinie), zeigen
die Browser keine Warnung. Das Serverzertifikat wird automatisch erneuert, wenn es bald abläuft oder
sich Rechnername/Adressen ändern – das Stammzertifikat bleibt dabei gleich.

Nur Python-Standardbibliothek (RSA, ASN.1/DER und X.509 hier selbst umgesetzt).
"""
import base64
import hashlib
import ipaddress
import json
import os
import secrets
import socket
from datetime import datetime, timedelta, timezone

KEY_BITS = 2048
CA_DAYS = 20 * 365
SERVER_DAYS = 825
RENEW_DAYS = 60

# ---------------------------------------------------------------- RSA

_SMALL_PRIMES = [p for p in range(3, 2000) if all(p % q for q in range(2, int(p ** 0.5) + 1))]


def _probable_prime(n, rounds=40):
    for p in _SMALL_PRIMES:
        if n % p == 0:
            return n == p
    d, r = n - 1, 0
    while d % 2 == 0:
        d //= 2
        r += 1
    for _ in range(rounds):
        a = secrets.randbelow(n - 3) + 2
        x = pow(a, d, n)
        if x in (1, n - 1):
            continue
        for _ in range(r - 1):
            x = pow(x, 2, n)
            if x == n - 1:
                break
        else:
            return False
    return True


def _prime(bits, e):
    while True:
        n = secrets.randbits(bits) | (3 << (bits - 2)) | 1
        if (n - 1) % e and _probable_prime(n):
            return n


def rsa_generate(bits=KEY_BITS, e=65537):
    while True:
        p, q = _prime(bits // 2, e), _prime(bits // 2, e)
        n = p * q
        if p != q and n.bit_length() == bits:
            break
    phi = (p - 1) * (q - 1)
    d = pow(e, -1, phi)
    return {"n": n, "e": e, "d": d, "p": p, "q": q}


def _i2b(i, length=None):
    length = length or max(1, (i.bit_length() + 7) // 8)
    return i.to_bytes(length, "big")


def rsa_sign_sha256(key, data):
    prefix = bytes.fromhex("3031300d060960864801650304020105000420")
    t = prefix + hashlib.sha256(data).digest()
    k = (key["n"].bit_length() + 7) // 8
    em = b"\x00\x01" + b"\xff" * (k - len(t) - 3) + b"\x00" + t
    p, q, d = key["p"], key["q"], key["d"]
    m = int.from_bytes(em, "big")
    # CRT – deutlich schneller als pow(m, d, n)
    m1, m2 = pow(m, d % (p - 1), p), pow(m, d % (q - 1), q)
    h = (pow(q, -1, p) * (m1 - m2)) % p
    return _i2b(m2 + h * q, k)


# ---------------------------------------------------------------- DER

def _len(n):
    if n < 0x80:
        return bytes([n])
    b = _i2b(n)
    return bytes([0x80 | len(b)]) + b


def tlv(tag, content):
    return bytes([tag]) + _len(len(content)) + content


def seq(*items):
    return tlv(0x30, b"".join(items))


def der_int(i):
    b = _i2b(i)
    if b[0] & 0x80:
        b = b"\x00" + b
    return tlv(0x02, b)


def oid(dotted):
    parts = [int(x) for x in dotted.split(".")]
    out = bytes([parts[0] * 40 + parts[1]])
    for p in parts[2:]:
        enc = [p & 0x7F]
        p >>= 7
        while p:
            enc.append(0x80 | (p & 0x7F))
            p >>= 7
        out += bytes(reversed(enc))
    return tlv(0x06, out)


NULL = b"\x05\x00"


def bitstring(b, unused=0):
    return tlv(0x03, bytes([unused]) + b)


def octets(b):
    return tlv(0x04, b)


def der_time(dt):
    if dt.year < 2050:
        return tlv(0x17, dt.strftime("%y%m%d%H%M%SZ").encode())
    return tlv(0x18, dt.strftime("%Y%m%d%H%M%SZ").encode())


def name(cn, org="OpenDeskSharing"):
    def rdn(o, v):
        return tlv(0x31, seq(oid(o), tlv(0x0C, v.encode("utf-8"))))
    return seq(rdn("2.5.4.10", org), rdn("2.5.4.3", cn))


def public_key_der(key):
    return seq(der_int(key["n"]), der_int(key["e"]))


def spki(key):
    return seq(seq(oid("1.2.840.113549.1.1.1"), NULL), bitstring(public_key_der(key)))


def private_key_pem(key):
    p, q, d = key["p"], key["q"], key["d"]
    der = seq(der_int(0), der_int(key["n"]), der_int(key["e"]), der_int(d), der_int(p), der_int(q),
              der_int(d % (p - 1)), der_int(d % (q - 1)), der_int(pow(q, -1, p)))
    return pem("RSA PRIVATE KEY", der)


def pem(label, der):
    b = base64.b64encode(der).decode()
    return f"-----BEGIN {label}-----\n" + "\n".join(b[i:i + 64] for i in range(0, len(b), 64)) + f"\n-----END {label}-----\n"


def pem_to_der(text):
    body = "".join(line for line in text.strip().splitlines() if not line.startswith("-----"))
    return base64.b64decode(body)


def private_key_from_pem(text):
    """Liest einen mit private_key_pem() geschriebenen Schlüssel wieder ein (nur für die eigene CA)."""
    der = pem_to_der(text)
    vals, i = [], 0

    def read(pos):
        tag, ln = der[pos], der[pos + 1]
        pos += 2
        if ln & 0x80:
            k = ln & 0x7F
            ln = int.from_bytes(der[pos:pos + k], "big")
            pos += k
        return tag, der[pos:pos + ln], pos + ln

    _, body, _ = read(0)
    der = body
    while i < len(der):
        _, v, i = read(i)
        vals.append(int.from_bytes(v, "big"))
    _, n, e, d, p, q = vals[:6]
    return {"n": n, "e": e, "d": d, "p": p, "q": q}


# ---------------------------------------------------------------- X.509

def _ext(o, value, critical=False):
    return seq(oid(o), *( [tlv(0x01, b"\xff")] if critical else []), octets(value))


def _key_id(key):
    return hashlib.sha1(public_key_der(key)).digest()


def make_cert(subject_cn, key, issuer_cn, issuer_key, days, ca=False, dns=(), ips=()):
    now = datetime.now(timezone.utc).replace(microsecond=0)
    alg = seq(oid("1.2.840.113549.1.1.11"), NULL)
    exts = [_ext("2.5.29.19", seq(tlv(0x01, b"\xff")) if ca else seq(), critical=True)]
    if ca:
        exts.append(_ext("2.5.29.15", bitstring(b"\x06", 1), critical=True))       # keyCertSign, cRLSign
    else:
        exts.append(_ext("2.5.29.15", bitstring(b"\xa0", 5), critical=True))       # digitalSignature, keyEncipherment
        exts.append(_ext("2.5.29.37", seq(oid("1.3.6.1.5.5.7.3.1"))))               # serverAuth
        san = b"".join([tlv(0x82, d.encode("idna") if d.isascii() is False else d.encode()) for d in dns] +
                       [tlv(0x87, ipaddress.ip_address(ip).packed) for ip in ips])
        exts.append(_ext("2.5.29.17", seq(san)))
    exts.append(_ext("2.5.29.14", octets(_key_id(key))))
    exts.append(_ext("2.5.29.35", seq(tlv(0x80, _key_id(issuer_key)))))
    tbs = seq(
        tlv(0xA0, der_int(2)),
        der_int(secrets.randbits(120) | (1 << 120)),
        alg,
        name(issuer_cn),
        seq(der_time(now - timedelta(days=1)), der_time(now + timedelta(days=days))),
        name(subject_cn),
        spki(key),
        tlv(0xA3, seq(*exts)),
    )
    return seq(tbs, alg, bitstring(rsa_sign_sha256(issuer_key, tbs)))


# ---------------------------------------------------------------- Verwaltung

def local_names(extra=()):
    """Rechnername, vollständiger Name, localhost und die IP-Adressen dieses Rechners."""
    dns, ips = [], ["127.0.0.1"]
    host = socket.gethostname()
    for n in [host, socket.getfqdn(), "localhost", *extra]:
        n = (n or "").strip().lower().rstrip(".")
        if not n:
            continue
        try:
            ipaddress.ip_address(n)
            if n not in ips:
                ips.append(n)
        except ValueError:
            if n not in dns:
                dns.append(n)
    try:
        for info in socket.getaddrinfo(host, None, socket.AF_INET):
            ip = info[4][0]
            if ip not in ips and not ip.startswith("169.254."):
                ips.append(ip)
    except OSError:
        pass
    return dns, ips


def fingerprint(der):
    h = hashlib.sha1(der).hexdigest().upper()
    return " ".join(h[i:i + 2] for i in range(0, len(h), 2))


def ensure_certs(tls_dir, extra_names=(), log=print):
    """Legt Stamm- und Serverzertifikat an bzw. erneuert das Serverzertifikat bei Bedarf.
    Gibt (cert_chain_pem, key_pem, info) zurück."""
    os.makedirs(tls_dir, exist_ok=True)
    ca_key_f = os.path.join(tls_dir, "ca.key.pem")
    ca_crt_f = os.path.join(tls_dir, "ca.crt.pem")
    ca_cer_f = os.path.join(tls_dir, "OpenDeskSharing-Stammzertifikat.cer")
    srv_key_f = os.path.join(tls_dir, "server.key.pem")
    srv_crt_f = os.path.join(tls_dir, "server.crt.pem")
    meta_f = os.path.join(tls_dir, "server.json")
    host = socket.gethostname()

    if not (os.path.exists(ca_key_f) and os.path.exists(ca_crt_f)):
        log("HTTPS: erzeuge Stammzertifikat (einmalig, dauert einige Sekunden) …")
        ca_key = rsa_generate()
        ca_cn = f"OpenDeskSharing Stammzertifikat ({host})"
        ca_der = make_cert(ca_cn, ca_key, ca_cn, ca_key, CA_DAYS, ca=True)
        _write(ca_key_f, private_key_pem(ca_key))
        _write(ca_crt_f, pem("CERTIFICATE", ca_der))
        for f in (srv_crt_f, meta_f):
            if os.path.exists(f):
                os.remove(f)
    with open(ca_crt_f, encoding="ascii") as f:
        ca_pem = f.read()
    ca_der = pem_to_der(ca_pem)
    if not os.path.exists(ca_cer_f):
        with open(ca_cer_f, "wb") as f:
            f.write(ca_der)
    meta = {}
    if os.path.exists(meta_f):
        try:
            with open(meta_f, encoding="utf-8") as f:
                meta = json.load(f)
        except (OSError, ValueError):
            meta = {}
    dns, ips = local_names(extra_names)
    renew = not (os.path.exists(srv_key_f) and os.path.exists(srv_crt_f))
    reason = "neu"
    if not renew:
        try:
            expires = datetime.fromisoformat(meta["not_after"])
            if expires - datetime.now(timezone.utc) < timedelta(days=RENEW_DAYS):
                renew, reason = True, "läuft bald ab"
            elif not (set(dns) <= set(meta.get("dns", [])) and set(ips) <= set(meta.get("ips", []))):
                renew, reason = True, "Rechnername/Adressen geändert"
        except (KeyError, ValueError):
            renew, reason = True, "Angaben fehlen"
    if renew:
        # Namen früherer Zertifikate behalten, damit wechselnde Adressen nicht ständig neu erzeugen
        dns = sorted(set(dns) | set(meta.get("dns", [])))
        ips = sorted(set(ips) | set(meta.get("ips", [])), key=lambda x: (x != "127.0.0.1", x))
        log(f"HTTPS: erzeuge Serverzertifikat ({reason}) für {', '.join(dns + ips)}")
        with open(ca_key_f, encoding="ascii") as f:
            ca_key = private_key_from_pem(f.read())
        ca_cn = f"OpenDeskSharing Stammzertifikat ({meta.get('ca_host') or _ca_host(ca_der) or host})"
        key = rsa_generate()
        der = make_cert(dns[0] if dns else host, key, ca_cn, ca_key, SERVER_DAYS, dns=dns, ips=ips)
        _write(srv_key_f, private_key_pem(key))
        _write(srv_crt_f, pem("CERTIFICATE", der) + ca_pem)
        not_after = datetime.now(timezone.utc).replace(microsecond=0) + timedelta(days=SERVER_DAYS)
        meta = {"dns": dns, "ips": ips, "not_after": not_after.isoformat(), "ca_host": meta.get("ca_host") or _ca_host(ca_der) or host}
        _write(meta_f, json.dumps(meta, indent=2))
    info = {"ca_file": ca_cer_f, "ca_fingerprint": fingerprint(ca_der), "names": meta.get("dns", []) + meta.get("ips", []),
            "not_after": meta.get("not_after", "")}
    return srv_crt_f, srv_key_f, info


def _ca_host(ca_der):
    # CN "OpenDeskSharing Stammzertifikat (HOST)" aus dem Zertifikat lesen
    i = ca_der.find(b"Stammzertifikat (")
    if i < 0:
        return ""
    j = ca_der.find(b")", i)
    return ca_der[i + 17:j].decode("utf-8", "replace")


def _write(path, text):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="ascii", newline="\n") as f:
        f.write(text)
    os.replace(tmp, path)
