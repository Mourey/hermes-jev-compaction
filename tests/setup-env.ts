// Tests must not depend on the developer's shell: a real key or endpoint
// override here would change which endpoint and key the integrations pick.
for (const name of [
  'TYPESAFE_API_KEY',
  'OPENROUTER_API_KEY',
  'FAST_JEV_API_KEY',
  'FAST_JEV_PROVIDER',
  'FAST_JEV_BASE_URL',
  'TYPESAFE_BASE_URL',
]) {
  delete process.env[name];
}
