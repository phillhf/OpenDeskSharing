"""
OpenDeskSharing – Anmeldung mit Windows-/Active-Directory-Konten.

Das Passwort wird nicht gespeichert und nicht selbst geprüft: Windows prüft es (LogonUser) gegen den
Domänencontroller bzw. – bei lokalen Konten – gegen die Kontendatenbank dieses Rechners. Danach werden
Gruppenmitgliedschaften am Anmelde-Token geprüft (inkl. verschachtelter Gruppen) und der Anzeigename
gelesen. Nur Python-Standardbibliothek (ctypes), nur unter Windows.
"""
import socket
import sys

AVAILABLE = sys.platform == "win32"

if AVAILABLE:
    import ctypes
    from ctypes import wintypes

    _advapi = ctypes.WinDLL("advapi32", use_last_error=True)
    _kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    _netapi = ctypes.WinDLL("netapi32", use_last_error=True)

    _advapi.LogonUserW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                   ctypes.POINTER(wintypes.HANDLE)]
    _advapi.LogonUserW.restype = wintypes.BOOL
    _advapi.GetTokenInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
    _advapi.GetTokenInformation.restype = wintypes.BOOL
    _advapi.LookupAccountSidW.argtypes = [wintypes.LPCWSTR, ctypes.c_void_p, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD),
                                          wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(ctypes.c_int)]
    _advapi.LookupAccountSidW.restype = wintypes.BOOL
    _advapi.LookupAccountNameW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, ctypes.c_void_p, ctypes.POINTER(wintypes.DWORD),
                                           wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD), ctypes.POINTER(ctypes.c_int)]
    _advapi.LookupAccountNameW.restype = wintypes.BOOL
    _advapi.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.LPWSTR)]
    _advapi.ConvertSidToStringSidW.restype = wintypes.BOOL
    _advapi.DuplicateToken.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.POINTER(wintypes.HANDLE)]
    _advapi.DuplicateToken.restype = wintypes.BOOL
    _advapi.CheckTokenMembership.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.POINTER(wintypes.BOOL)]
    _advapi.CheckTokenMembership.restype = wintypes.BOOL
    _kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    _kernel.LocalFree.argtypes = [ctypes.c_void_p]
    _netapi.NetUserGetInfo.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p)]
    _netapi.NetUserGetInfo.restype = wintypes.DWORD
    _netapi.DsGetDcNameW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR, ctypes.c_void_p, wintypes.LPCWSTR, wintypes.ULONG,
                                     ctypes.POINTER(ctypes.c_void_p)]
    _netapi.DsGetDcNameW.restype = wintypes.DWORD
    _netapi.NetApiBufferFree.argtypes = [ctypes.c_void_p]

    class _USER_INFO_10(ctypes.Structure):
        _fields_ = [("name", wintypes.LPWSTR), ("comment", wintypes.LPWSTR), ("usr_comment", wintypes.LPWSTR),
                    ("full_name", wintypes.LPWSTR)]

LOGON32_LOGON_NETWORK = 3
LOGON32_PROVIDER_DEFAULT = 0
TOKEN_USER = 1
SECURITY_IMPERSONATION = 2

# Windows-Fehlercodes von LogonUser -> (Art, verständliche Meldung)
LOGON_ERRORS = {
    1326: ("credentials", "Benutzername oder Passwort falsch"),
    1327: ("account", "Anmeldung für dieses Konto derzeit nicht erlaubt (Kontoeinschränkung, z. B. Anmeldezeiten)"),
    1328: ("account", "Anmeldung zu dieser Uhrzeit für das Konto nicht erlaubt"),
    1329: ("account", "Das Konto darf sich an diesem Rechner nicht anmelden"),
    1330: ("account", "Das Windows-Passwort ist abgelaufen – bitte zuerst am PC ändern"),
    1331: ("account", "Das Windows-Konto ist deaktiviert"),
    1793: ("account", "Das Windows-Konto ist abgelaufen"),
    1907: ("account", "Das Windows-Passwort muss zuerst geändert werden – bitte am PC ändern"),
    1909: ("account", "Das Windows-Konto ist gesperrt (zu viele Fehlversuche) – bitte später erneut versuchen oder die IT fragen"),
    1385: ("config", "Das Konto hat auf dem OpenDeskSharing-Server nicht das Recht „Auf diesen Computer vom Netzwerk aus zugreifen“"),
    1311: ("config", "Kein Domänencontroller erreichbar"),
    1355: ("config", "Die eingestellte Domäne existiert nicht oder ist nicht erreichbar"),
    1717: ("config", "Die Anmeldung konnte nicht geprüft werden (Dienst nicht verfügbar)"),
    1788: ("config", "Die Vertrauensstellung zur Domäne ist gestört"),
    1789: ("config", "Die Vertrauensstellung dieses Servers zur Domäne ist gestört"),
}


class AdError(Exception):
    def __init__(self, kind, message, code=0):
        super().__init__(message)
        self.kind = kind          # credentials | account | config | group
        self.message = message
        self.code = code


def split_login(raw):
    """'FIRMA\\max', 'max@firma.de' oder 'max' -> (Anmeldename, Domäne aus der Eingabe oder None, UPN?)."""
    raw = (raw or "").strip()
    if "\\" in raw:
        dom, user = raw.split("\\", 1)
        return user.strip(), dom.strip() or None, False
    if "@" in raw:
        return raw, None, True
    return raw, None, False


def _sid_of_token(h):
    need = wintypes.DWORD()
    _advapi.GetTokenInformation(h, TOKEN_USER, None, 0, ctypes.byref(need))
    buf = ctypes.create_string_buffer(need.value)
    if not _advapi.GetTokenInformation(h, TOKEN_USER, buf, need, ctypes.byref(need)):
        raise AdError("config", f"Token-Abfrage fehlgeschlagen ({ctypes.get_last_error()})")
    psid = ctypes.cast(buf, ctypes.POINTER(ctypes.c_void_p))[0]
    return buf, psid


def _sid_string(psid):
    s = wintypes.LPWSTR()
    if not _advapi.ConvertSidToStringSidW(psid, ctypes.byref(s)):
        return ""
    try:
        return s.value
    finally:
        _kernel.LocalFree(s)


def _account_of_sid(psid):
    n, d, use = wintypes.DWORD(256), wintypes.DWORD(256), ctypes.c_int()
    name, dom = ctypes.create_unicode_buffer(256), ctypes.create_unicode_buffer(256)
    if not _advapi.LookupAccountSidW(None, psid, name, ctypes.byref(n), dom, ctypes.byref(d), ctypes.byref(use)):
        return None, None
    return name.value, dom.value


def lookup_group(group, default_domain):
    """Gruppenname -> SID-Puffer. 'Gruppe' wird zuerst in der Domäne des Benutzers gesucht."""
    tries = [group] if "\\" in group or "@" in group else [f"{default_domain}\\{group}", group]
    for g in tries:
        cb, cd, use = wintypes.DWORD(0), wintypes.DWORD(0), ctypes.c_int()
        _advapi.LookupAccountNameW(None, g, None, ctypes.byref(cb), None, ctypes.byref(cd), ctypes.byref(use))
        if not cb.value:
            continue
        sid = ctypes.create_string_buffer(cb.value)
        dom = ctypes.create_unicode_buffer(cd.value + 1)
        if _advapi.LookupAccountNameW(None, g, sid, ctypes.byref(cb), dom, ctypes.byref(cd), ctypes.byref(use)):
            if use.value in (2, 4, 5):  # SidTypeGroup, SidTypeAlias, SidTypeWellKnownGroup
                return sid
            raise AdError("group", f"„{group}“ ist keine Gruppe")
    raise AdError("group", f"Die Gruppe „{group}“ wurde nicht gefunden")


def _is_member(token, sid):
    imp = wintypes.HANDLE()
    if not _advapi.DuplicateToken(token, SECURITY_IMPERSONATION, ctypes.byref(imp)):
        raise AdError("config", f"Gruppenprüfung fehlgeschlagen ({ctypes.get_last_error()})")
    try:
        res = wintypes.BOOL()
        if not _advapi.CheckTokenMembership(imp, sid, ctypes.byref(res)):
            raise AdError("config", f"Gruppenprüfung fehlgeschlagen ({ctypes.get_last_error()})")
        return bool(res.value)
    finally:
        _kernel.CloseHandle(imp)


def _display_name(sam, account_domain):
    """Vollständiger Name aus dem AD (bzw. der lokalen Kontenverwaltung); leer, wenn nicht ermittelbar."""
    server = None
    if account_domain and account_domain.upper() != socket.gethostname().upper():
        p = ctypes.c_void_p()
        if _netapi.DsGetDcNameW(None, account_domain, None, None, 0, ctypes.byref(p)) == 0 and p.value:
            try:
                server = ctypes.cast(p, ctypes.POINTER(wintypes.LPWSTR))[0]  # DomainControllerName (\\dc01...)
            finally:
                _netapi.NetApiBufferFree(p)
    buf = ctypes.c_void_p()
    if _netapi.NetUserGetInfo(server, sam, 10, ctypes.byref(buf)) != 0 or not buf.value:
        return ""
    try:
        return (ctypes.cast(buf, ctypes.POINTER(_USER_INFO_10))[0].full_name or "").strip()
    finally:
        _netapi.NetApiBufferFree(buf)


def authenticate(login, password, domain, groups=None):
    """Prüft die Anmeldung. groups: {schlüssel: gruppenname} – Ergebnis enthält member[schlüssel] = True/False.
    Rückgabe: {username, domain, sid, display_name, member}. Fehler: AdError."""
    if not AVAILABLE:
        raise AdError("config", "Windows-Anmeldung ist nur verfügbar, wenn der Server unter Windows läuft")
    user, typed_domain, upn = split_login(login)
    if not user or not password:
        raise AdError("credentials", "Benutzername oder Passwort falsch")
    dom = None if upn else (domain or typed_domain or ".")
    h = wintypes.HANDLE()
    if not _advapi.LogonUserW(user, dom, password, LOGON32_LOGON_NETWORK, LOGON32_PROVIDER_DEFAULT, ctypes.byref(h)):
        code = ctypes.get_last_error()
        kind, msg = LOGON_ERRORS.get(code, ("config", f"Windows-Anmeldung fehlgeschlagen (Fehler {code})"))
        raise AdError(kind, msg, code)
    try:
        keep, psid = _sid_of_token(h)
        sid = _sid_string(psid)
        sam, acc_domain = _account_of_sid(psid)
        sam = sam or user
        member, group_errors = {}, {}
        for key, g in (groups or {}).items():
            g = (g or "").strip()
            if not g:
                continue
            try:
                member[key] = _is_member(h, lookup_group(g, acc_domain or dom or ""))
            except AdError as e:
                member[key] = False
                group_errors[key] = e.message
        del keep
    finally:
        _kernel.CloseHandle(h)
    return {"username": sam, "domain": acc_domain or "", "sid": sid, "display_name": _display_name(sam, acc_domain) or sam,
            "member": member, "group_errors": group_errors}
