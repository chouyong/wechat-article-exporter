import { exportMpAccounts } from '~/server/utils/mp-account-registry';

export default defineEventHandler(() => ({
  generatedAt: new Date().toISOString(),
  accounts: exportMpAccounts(),
}));
