import { initializeMpAccountRegistry } from '~/server/utils/mp-account-registry';

export default defineNitroPlugin(() => {
  initializeMpAccountRegistry();
});
