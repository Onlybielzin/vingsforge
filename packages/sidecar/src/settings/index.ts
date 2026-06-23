/**
 * Settings feature barrel (Spec 07): the SettingsStore (layered config + API-key
 * lifecycle + key/model validation), the SecretStore abstraction (libsecret +
 * in-memory) and the injectable Anthropic validation port.
 */
export * from './secret-store.js';
export * from './client.js';
export * from './settings-store.js';
