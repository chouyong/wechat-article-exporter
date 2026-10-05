import LoginModal from '~/components/modal/Login.vue';

export default () => {
  const modal = useModal();
  const loginAccount = useLoginAccount();

  // 检查是否有登录信息
  function checkLogin() {
    // 旧版本 localStorage 中的登录对象没有 fakeid，不能继续把旧主体当作有效会话。
    if (!loginAccount.value?.fakeid) {
      loginAccount.value = null;
      modal.open(LoginModal);
      return false;
    }
    return true;
  }

  return {
    checkLogin,
  };
};
