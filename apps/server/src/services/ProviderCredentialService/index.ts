import {
  editCredential,
  exportCredentialById,
  getDefaultCredentialIdByProviderId,
  getFullCredentialById,
  getSafeCredentialById,
  getSecretByCredentialId,
  getSecretByProviderId,
  listSafeCredentials,
  readRefreshToken,
  removeCredential,
  resolveCredentialIdForModel,
  saveCredential,
  saveCredentialBundle,
  updateCredentialSecret,
  upsertProviderSecret,
} from './credentials';

export const providerCredentialService = {
  listSafe: listSafeCredentials,
  save: saveCredential,
  upsertSecret: upsertProviderSecret,
  saveBundle: saveCredentialBundle,
  remove: removeCredential,
  edit: editCredential,
  exportById: exportCredentialById,
  getSecretById: getSecretByCredentialId,
  getSecret: getSecretByProviderId,
  getDefaultCredentialId: getDefaultCredentialIdByProviderId,
  getFullCredentialById,
  getSafeById: getSafeCredentialById,
  readRefreshToken,
  resolveCredentialIdForModel,
  updateSecret: updateCredentialSecret,
};

export { seedEnvironmentTestCredentials } from './environmentCredentials';
