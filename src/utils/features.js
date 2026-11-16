function envFeatureEnabled(name, defaultValue = true, env = process.env) {
  const raw = env[name];
  if (raw == null || String(raw).trim() === '') return defaultValue;
  return !['0', 'false', 'off', 'no'].includes(String(raw).trim().toLowerCase());
}

function prmAvailabilityEnabled(env = process.env) {
  return envFeatureEnabled('ENABLE_PRM_AVAILABILITY', true, env);
}

module.exports = { envFeatureEnabled, prmAvailabilityEnabled };
