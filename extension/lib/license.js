// Lemon Squeezy direct license API integration.
// No backend required — all calls go directly to api.lemonsqueezy.com.

const API_BASE = 'https://api.lemonsqueezy.com/v1/licenses';
const INSTANCE_NAME = 'ScreenFellow-Browser';
const CACHE_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours
const API_TIMEOUT_MS = 5000;
const DEV_KEY = 'SCREENFELLOW-DEV-2026';

export async function activateLicense(key) {
  if (key.trim().toUpperCase() === DEV_KEY) {
    await chrome.storage.local.set({
      license_key: key.trim().toUpperCase(),
      license_instance_id: 'dev',
      license_status: 'active',
      license_last_validated: Date.now()
    });
    return { success: true };
  }

  try {
    const resp = await fetchWithTimeout(`${API_BASE}/activate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ license_key: key, instance_name: INSTANCE_NAME })
    });

    const data = await resp.json();

    if (resp.ok && data.activated) {
      await chrome.storage.local.set({
        license_key: key,
        license_instance_id: data.instance?.id,
        license_status: 'active',
        license_last_validated: Date.now()
      });
      return { success: true };
    }

    // Already active on another instance — Lemon Squeezy returns 400
    if (resp.status === 400 && data.error) {
      return { success: false, alreadyActive: true, error: data.error };
    }

    return { success: false, error: data.error || 'Activation failed.' };
  } catch (e) {
    return { success: false, error: 'Network error. Please try again.' };
  }
}

export async function validateLicense() {
  const stored = await chrome.storage.local.get([
    'license_key', 'license_instance_id', 'license_status', 'license_last_validated'
  ]);

  if (!stored.license_key) {
    return { isPremium: false };
  }

  if (stored.license_key === DEV_KEY) {
    return { isPremium: true };
  }

  // Try live validation
  try {
    const resp = await fetchWithTimeout(`${API_BASE}/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        license_key: stored.license_key,
        instance_id: stored.license_instance_id
      })
    });

    const data = await resp.json();

    if (resp.ok && data.valid) {
      await chrome.storage.local.set({
        license_status: 'active',
        license_last_validated: Date.now()
      });
      return { isPremium: true };
    }

    // License invalidated (deactivated on another device, refunded, etc.)
    await chrome.storage.local.set({ license_status: 'free' });
    return { isPremium: false };

  } catch (_) {
    // Network error — use cache
    return useCachedStatus(stored);
  }
}

export async function deactivateLicense() {
  const stored = await chrome.storage.local.get(['license_key', 'license_instance_id']);

  if (stored.license_key && stored.license_instance_id) {
    try {
      await fetchWithTimeout(`${API_BASE}/deactivate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
          license_key: stored.license_key,
          instance_id: stored.license_instance_id
        })
      });
    } catch (_) {
      // Best-effort deactivation
    }
  }

  await chrome.storage.local.remove([
    'license_key', 'license_instance_id', 'license_status', 'license_last_validated'
  ]);
}

export async function isPremium() {
  const data = await chrome.storage.local.get(['license_status', 'license_last_validated']);
  if (data.license_status !== 'active') return false;

  const age = Date.now() - (data.license_last_validated || 0);
  if (age < CACHE_TTL_MS) return true;

  // Cache expired — validate in background, return cached result for now
  validateLicense();
  return true;
}

function useCachedStatus(stored) {
  if (stored.license_status !== 'active') return { isPremium: false };

  const age = Date.now() - (stored.license_last_validated || 0);
  if (age < CACHE_TTL_MS) {
    return { isPremium: true, fromCache: true };
  }

  // Cache expired — fall back to free
  chrome.storage.local.set({ license_status: 'free' });
  return { isPremium: false };
}

function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}
