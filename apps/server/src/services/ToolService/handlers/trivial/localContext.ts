import type { ToolHandler } from '@server/services/ToolService/types';
import { getErrorMessage } from '@snaglet/shared/utils';

/**
 * get_local_context — keyless IP geolocation: resolve the server's public IP
 * to a city (primary ipwho.is, fallback ipapi.co). Both providers are free
 * and need no API key or signup.
 *
 * City-level only — this resolves the SERVER's public IP, not the end
 * user's GPS. TOOL.md is explicit about the limitation so agents don't
 * oversell it.
 *
 * Nothing is persisted: the lookup is live and kept only in the short
 * in-memory cache below.
 */

interface LocationResult {
  city: string;
  region: string;
  country: string;
  lat: number;
  lon: number;
  timezone: string;
}

// A short TTL, not a general-purpose cache: just enough to keep repeated calls
// in the same turn from hammering free rate-limited endpoints.
const LOCATION_TTL_MS = 5 * 60 * 1000;

let locationCache: { value: LocationResult; expiresAt: number } | null = null;
async function fetchIpwhoIs(): Promise<LocationResult> {
  const res = await fetch('https://ipwho.is/');
  if (!res.ok) throw new Error(`ipwho.is request failed (${res.status})`);
  const json = (await res.json()) as Record<string, unknown>;
  if (json.success === false) {
    throw new Error(String(json.message ?? 'ipwho.is lookup failed'));
  }
  const timezone = json.timezone as { id?: string } | undefined;
  return {
    city: String(json.city ?? 'unknown'),
    region: String(json.region ?? 'unknown'),
    country: String(json.country ?? 'unknown'),
    lat: Number(json.latitude),
    lon: Number(json.longitude),
    timezone: String(timezone?.id ?? 'UTC'),
  };
}

async function fetchIpapiCo(): Promise<LocationResult> {
  const res = await fetch('https://ipapi.co/json/');
  if (!res.ok) throw new Error(`ipapi.co request failed (${res.status})`);
  const json = (await res.json()) as Record<string, unknown>;
  if (json.error) {
    throw new Error(String(json.reason ?? 'ipapi.co lookup failed'));
  }
  return {
    city: String(json.city ?? 'unknown'),
    region: String(json.region ?? 'unknown'),
    country: String(json.country_name ?? 'unknown'),
    lat: Number(json.latitude),
    lon: Number(json.longitude),
    timezone: String(json.timezone ?? 'UTC'),
  };
}

// Primary + one fallback, per the chain contract — ipwho.is first (richer,
// reliably free), ipapi.co second (tighter free-tier rate limit).
const LOCATION_PROVIDERS = [fetchIpwhoIs, fetchIpapiCo];

async function resolveLocation(): Promise<LocationResult> {
  if (locationCache && locationCache.expiresAt > Date.now()) {
    return locationCache.value;
  }

  const errors: string[] = [];
  for (const provider of LOCATION_PROVIDERS) {
    try {
      const value = await provider();
      if (!Number.isFinite(value.lat) || !Number.isFinite(value.lon)) {
        throw new Error('provider returned no coordinates');
      }
      locationCache = { value, expiresAt: Date.now() + LOCATION_TTL_MS };
      return value;
    } catch (err) {
      errors.push(getErrorMessage(err));
    }
  }

  throw new Error(`all location providers failed: ${errors.join('; ')}`);
}

const tool: ToolHandler = async () => {
  try {
    const location = await resolveLocation();
    return JSON.stringify({ location }, null, 2);
  } catch (err) {
    // Both providers failed: return a structured error the agent can relay.
    return JSON.stringify(
      {
        error: true,
        message: `Could not resolve location: ${getErrorMessage(err)}`,
        location: null,
      },
      null,
      2
    );
  }
};

export default tool;
