/* =========================================================
   api.js — BuildResume API client layer
   =========================================================
   Owns: the backend base URL, a single fetch wrapper (apiFetch)
   that attaches the access token and silently refreshes it on a
   401, token/device_id storage, and one function per backend auth
   endpoint. script.js calls these functions and handles what to do
   with the result (which page to show, which toast to display) --
   no UI logic lives here, only "talk to the backend" logic, so
   Phase 2 (resumes/templates) can reuse apiFetch() unchanged.

   Backend endpoints used here already exist and are unchanged by
   this file: POST /auth/register, POST /auth/register/verify-otp,
   POST /auth/login, POST /auth/login/verify-otp, POST /auth/refresh,
   POST /auth/logout, GET /auth/me.
   ========================================================= */

/* Change this to your deployed backend's URL in production. */
const API_BASE_URL = "http://127.0.0.1:8000/api/v1";

/* ---- Token / device_id storage ----
   localStorage (not sessionStorage/cookies): the backend's rolling-
   session design (device-bound refresh tokens) assumes the client
   persists the refresh token + device_id across browser restarts --
   see app/services/session_service.py's docs. Trade-off, stated
   plainly: localStorage is readable by any script running on this
   page, so it's only as safe as the app's overall XSS surface. An
   httpOnly-cookie-based approach would be safer but requires the
   backend's token endpoints to set cookies instead of returning JSON,
   which is out of scope for this phase. */
const STORAGE_KEYS = {
  accessToken: "br_access_token",
  refreshToken: "br_refresh_token",
  deviceId: "br_device_id",
};

function getAccessToken() {
  return localStorage.getItem(STORAGE_KEYS.accessToken) || null;
}

function getRefreshToken() {
  return localStorage.getItem(STORAGE_KEYS.refreshToken) || null;
}

function getDeviceId() {
  return localStorage.getItem(STORAGE_KEYS.deviceId) || null;
}

/* `tokenData` is whatever TokenResponse the backend returned --
   {access_token, refresh_token, token_type, device_id?}. device_id is
   only present on login (not refresh), so it's only overwritten when
   actually provided, never blanked out. */
function storeTokens(tokenData) {
  if (!tokenData) return;
  if (tokenData.access_token) localStorage.setItem(STORAGE_KEYS.accessToken, tokenData.access_token);
  if (tokenData.refresh_token) localStorage.setItem(STORAGE_KEYS.refreshToken, tokenData.refresh_token);
  if (tokenData.device_id) localStorage.setItem(STORAGE_KEYS.deviceId, tokenData.device_id);
}

function clearTokens() {
  localStorage.removeItem(STORAGE_KEYS.accessToken);
  localStorage.removeItem(STORAGE_KEYS.refreshToken);
  /* device_id is deliberately KEPT on logout -- it identifies this
     browser/device for "remember me" purposes, not this session; the
     next login from here should still be recognized as the same device. */
}

/* Decodes a JWT's payload WITHOUT verifying its signature -- this is
   only ever used client-side to answer "does this look expired?" for
   UX purposes (deciding whether to bother calling /auth/refresh
   before a request). The backend is always the real authority on
   whether a token is actually valid. */
function decodeJwtPayload(token) {
  try {
    const payloadB64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(payloadB64));
  } catch (e) {
    return null;
  }
}

function isAccessTokenExpired() {
  const token = getAccessToken();
  if (!token) return true;
  const payload = decodeJwtPayload(token);
  if (!payload || !payload.exp) return true;
  const nowSeconds = Date.now() / 1000;
  const SAFETY_MARGIN_SECONDS = 15; // refresh a little before the real expiry
  return nowSeconds >= (payload.exp - SAFETY_MARGIN_SECONDS);
}

/** True if there's a token that looks usable right now (access token
 * present and not expired). Does NOT itself attempt a refresh --
 * callers that want "am I logged in, accounting for a refreshable
 * expired token" should use ensureValidSession() instead. */
function hasStoredSession() {
  return !!getAccessToken() && !!getRefreshToken();
}

/* ---- Error shape ----
   Every throw from apiFetch() is one of these, so callers can always
   do `catch (err) { showToast(err.message, "error") }` without caring
   which endpoint failed or why. */
function ApiError(message, status, data) {
  this.name = "ApiError";
  this.message = message;
  this.status = status;
  this.data = data;
}
ApiError.prototype = Object.create(Error.prototype);

function extractErrorMessage(data, fallback) {
  if (!data || !data.detail) return fallback;
  if (typeof data.detail === "string") return data.detail;
  if (Array.isArray(data.detail)) {
    // FastAPI/Pydantic validation error shape: [{msg: "...", ...}, ...]
    return data.detail.map(function (d) { return d.msg || JSON.stringify(d); }).join(", ");
  }
  return fallback;
}

/**
 * Core fetch wrapper used by every function below.
 * - Attaches "Authorization: Bearer <token>" automatically, unless
 *   options.skipAuth is true (used for register/login/refresh, which
 *   don't require -- and in refresh's case, must not send -- a bearer token).
 * - On a 401 from an authenticated call, attempts exactly ONE silent
 *   refresh-and-retry before giving up (prevents infinite loops if
 *   the refresh token itself is also invalid).
 * - Always throws an ApiError with a human-readable message on any
 *   non-2xx response or network failure -- callers never need to
 *   inspect raw Response objects.
 */
async function apiFetch(path, options) {
  options = options || {};
  const headers = Object.assign({ "Content-Type": "application/json" }, options.headers || {});

  if (!options.skipAuth) {
    const token = getAccessToken();
    if (token) headers["Authorization"] = "Bearer " + token;
  }

  let response;
  try {
    response = await fetch(API_BASE_URL + path, {
      method: options.method || "GET",
      headers: headers,
      body: options.body,
    });
  } catch (networkErr) {
    throw new ApiError("Could not reach the server. Check your connection and try again.", 0, null);
  }

  if (response.status === 401 && !options.skipAuth && !options._isRetry) {
    const refreshed = await attemptSilentRefresh();
    if (refreshed) {
      return apiFetch(path, Object.assign({}, options, { _isRetry: true }));
    }
  }

  let data = null;
  try {
    data = await response.json();
  } catch (e) {
    data = null;
  }

  if (!response.ok) {
    throw new ApiError(
      extractErrorMessage(data, "Request failed (" + response.status + ")"),
      response.status,
      data
    );
  }

  return data;
}

/* Used internally by apiFetch's 401 handling. Swallows errors (returns
   false) rather than throwing, since the caller just wants a yes/no
   on "should I retry the original request now". */
async function attemptSilentRefresh() {
  const refresh_token = getRefreshToken();
  if (!refresh_token) return false;
  try {
    const tokenData = await apiFetch("/auth/refresh", {
      method: "POST",
      skipAuth: true,
      body: JSON.stringify({ refresh_token: refresh_token }),
    });
    storeTokens(tokenData);
    return true;
  } catch (e) {
    clearTokens();
    return false;
  }
}

/**
 * Ensures the current session is actually usable before proceeding --
 * proactively refreshes if the access token looks expired, rather
 * than waiting to discover that via a 401 on some unrelated call.
 * Returns true if the caller can proceed as "logged in", false
 * otherwise (and clears storage in the false case).
 */
async function ensureValidSession() {
  if (!hasStoredSession()) return false;
  if (!isAccessTokenExpired()) return true;
  return attemptSilentRefresh();
}

/* =========================================================
   Auth endpoint functions -- one per backend route.
   ========================================================= */

/** POST /auth/register -- step 1 of signup; sends a signup OTP. */
function registerUser(email, username, password) {
  return apiFetch("/auth/register", {
    method: "POST",
    skipAuth: true,
    body: JSON.stringify({ email: email, username: username, password: password }),
  });
}

/** POST /auth/register/verify-otp -- step 2 of signup; creates the account. */
function verifyRegisterOtp(email, otp_code) {
  return apiFetch("/auth/register/verify-otp", {
    method: "POST",
    skipAuth: true,
    body: JSON.stringify({ email: email, otp_code: otp_code }),
  });
}

/** POST /auth/login -- step 1 of login; validates credentials, sends a login OTP. */
function loginUser(email, password) {
  return apiFetch("/auth/login", {
    method: "POST",
    skipAuth: true,
    body: JSON.stringify({ email: email, password: password }),
  });
}

/**
 * POST /auth/login/verify-otp -- step 2 of login; issues tokens.
 * Sends the stored device_id (if any) so a returning device is
 * recognized per the backend's "remember device" design. Stores the
 * returned tokens automatically on success.
 */
async function verifyLoginOtp(email, otp_code) {
  const payload = { email: email, otp_code: otp_code };
  const existingDeviceId = getDeviceId();
  if (existingDeviceId) payload.device_id = existingDeviceId;

  const tokenData = await apiFetch("/auth/login/verify-otp", {
    method: "POST",
    skipAuth: true,
    body: JSON.stringify(payload),
  });
  storeTokens(tokenData);
  return tokenData;
}

/**
 * POST /auth/refresh -- exchanges the stored refresh token for a new
 * pair, storing the result. Exposed for completeness/explicit calls;
 * apiFetch()'s automatic 401 handling uses attemptSilentRefresh()
 * internally rather than this, but the behavior is identical.
 */
async function refreshTokens() {
  const refresh_token = getRefreshToken();
  if (!refresh_token) throw new ApiError("No active session to refresh.", 401, null);
  const tokenData = await apiFetch("/auth/refresh", {
    method: "POST",
    skipAuth: true,
    body: JSON.stringify({ refresh_token: refresh_token }),
  });
  storeTokens(tokenData);
  return tokenData;
}

/**
 * POST /auth/logout -- revokes the current device's session on the
 * backend. Always clears local tokens regardless of whether the
 * backend call itself succeeds (a network hiccup shouldn't be able to
 * strand the user in a "can't log out" state).
 */
async function logoutUser() {
  const refresh_token = getRefreshToken();
  try {
    if (refresh_token) {
      await apiFetch("/auth/logout", {
        method: "POST",
        skipAuth: true,
        body: JSON.stringify({ refresh_token: refresh_token }),
      });
    }
  } catch (e) {
    // Intentionally swallowed -- logging out client-side must always
    // succeed even if the backend call fails (offline, token already
    // expired, etc).
  } finally {
    clearTokens();
  }
}

/** GET /auth/me -- the current authenticated user's profile. */
function getCurrentUser() {
  return apiFetch("/auth/me", { method: "GET" });
}

/* =========================================================
   Resume endpoint functions -- one per backend route.
   ========================================================= */

/** GET /resumes -- every resume owned by the authenticated user. */
function getResumes() {
  return apiFetch("/resumes", { method: "GET" });
}

/** GET /resumes/{id} -- a single resume. */
function getResume(id) {
  return apiFetch("/resumes/" + id, { method: "GET" });
}

/**
 * POST /resumes -- create a new resume. Every field in `payload`
 * (title/template_id/resume_data/formatting_data) is optional on the
 * backend, so this can be called with a minimal payload.
 */
function createResume(payload) {
  return apiFetch("/resumes", {
    method: "POST",
    body: JSON.stringify(payload || {}),
  });
}

/** PUT /resumes/{id} -- partially update a resume; only send changed fields. */
function updateResume(id, payload) {
  return apiFetch("/resumes/" + id, {
    method: "PUT",
    body: JSON.stringify(payload || {}),
  });
}

/**
 * DELETE /resumes/{id}. Returns no body (204 No Content).
 *
 * Named deleteResumeApi rather than deleteResume deliberately:
 * script.js already defines a higher-level deleteResume() (which
 * calls this function, then updates the Home page, shows a toast,
 * etc). Since both files share one global scope, naming this
 * identically would silently shadow script.js's version.
 */
function deleteResumeApi(id) {
  return apiFetch("/resumes/" + id, { method: "DELETE" });
}

/* =========================================================
   AI assistant endpoint function.
   ========================================================= */

/**
 * POST /ai/chat -- sends a single user message (and, optionally, the
 * id of the resume currently open in the Builder) to the backend's
 * Gemini-backed AI assistant and returns its text response.
 *
 * Goes through apiFetch() like every other authenticated call here,
 * so it automatically gets the "Authorization: Bearer <token>"
 * header and the silent 401-refresh-and-retry behavior -- no
 * separate auth handling needed. The Gemini API key itself is never
 * seen by this file or any other frontend code; it lives only in the
 * backend's environment.
 *
 * Only the resume's id is ever sent -- never the resume content
 * itself. The backend looks the resume up server-side (the same
 * ownership-enforced path GET /resumes/{id} uses) and builds Gemini
 * context from that, so a tampered/forged id can't leak someone
 * else's resume through this endpoint.
 *
 * @param {string} message
 * @param {string|null} [resumeId] - id of the resume currently open
 *   in the Builder, or null/omitted if none (e.g. before first save).
 * @returns {Promise<string>} the assistant's response text (unwrapped
 *   from the backend's {response: "..."} shape).
 */
async function sendAiChatMessage(message, resumeId) {
  const data = await apiFetch("/ai/chat", {
    method: "POST",
    body: JSON.stringify({ message: message, resume_id: resumeId }),
  });
  return data.response;
}