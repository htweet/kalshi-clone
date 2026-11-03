// Passkeys in the browser (PLAN P3.4, CLONE_SPEC §25): converts the server's JSON options (base64url strings) to the
// ArrayBuffers navigator.credentials expects, and the resulting credential back to JSON.
const toBuf = (s) => { const b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(s).length / 4) * 4, '=')); return Uint8Array.from(b, (c) => c.charCodeAt(0)).buffer; };
const toB64u = (buf) => { let s = ''; for (const x of new Uint8Array(buf)) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };

export const passkeysSupported = () => !!(window.PublicKeyCredential && navigator.credentials && window.isSecureContext);

export async function createPasskey(options) {
  const pk = options.publicKey;
  const cred = await navigator.credentials.create({ publicKey: {
    ...pk, challenge: toBuf(pk.challenge), user: { ...pk.user, id: toBuf(pk.user.id) },
    excludeCredentials: (pk.excludeCredentials || []).map((c) => ({ ...c, id: toBuf(c.id) })),
  } });
  return {
    id: cred.id, rawId: toB64u(cred.rawId), type: cred.type, authenticatorAttachment: cred.authenticatorAttachment || null,
    response: { clientDataJSON: toB64u(cred.response.clientDataJSON), attestationObject: toB64u(cred.response.attestationObject), transports: cred.response.getTransports ? cred.response.getTransports() : [] },
  };
}

export async function getPasskey(options) {
  const pk = options.publicKey;
  const cred = await navigator.credentials.get({ publicKey: { ...pk, challenge: toBuf(pk.challenge), allowCredentials: (pk.allowCredentials || []).map((c) => ({ ...c, id: toBuf(c.id) })) } });
  return {
    id: cred.id, rawId: toB64u(cred.rawId), type: cred.type, authenticatorAttachment: cred.authenticatorAttachment || null,
    response: { clientDataJSON: toB64u(cred.response.clientDataJSON), authenticatorData: toB64u(cred.response.authenticatorData), signature: toB64u(cred.response.signature), userHandle: cred.response.userHandle ? toB64u(cred.response.userHandle) : null },
  };
}
