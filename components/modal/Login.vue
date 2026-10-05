<script setup lang="ts">
import { createAccountOwnerKey, setCurrentAccountOwnerKey } from '#shared/utils/account-session';
import { request } from '#shared/utils/request';
import type { LoginAccount, ScanLoginResult, StartLoginResult } from '~/types/types';

const modal = useModal();

const qrcodeSrc = ref('');
const loading = ref(false);
const msg = ref('');

const checkTimer = ref<number | null>(null);
const loginMode = ref<'qrcode' | 'password'>('qrcode');
const username = ref('');
const password = ref('');

const loginAccount = useLoginAccount();

onMounted(() => {
  getQrcode();
});

function closeModal() {
  modal.close();

  window.clearTimeout(checkTimer.value!);
  checkTimer.value = null;
  password.value = '';
}

function switchLoginMode(mode: 'qrcode' | 'password') {
  loginMode.value = mode;
  msg.value = '';
  qrcodeSrc.value = '';
  window.clearTimeout(checkTimer.value!);
  checkTimer.value = null;
  if (mode === 'qrcode') {
    getQrcode();
  }
}

/**
 * 创建新的登录会话
 *
 * 该请求会在response中设置一个唯一的uuid(cookie)作为会话id
 */
async function newLoginSession() {
  const sid = new Date().getTime().toString() + Math.floor(Math.random() * 100);
  const resp = await request<StartLoginResult>(`/api/web/login/session/${sid}`, { method: 'POST' });
  if (!resp || !resp.base_resp || resp.base_resp.ret !== 0) {
    throw new Error(`${resp?.base_resp?.err_msg || '获取登录会话失败'}`);
  }
}

// 获取登录二维码
async function getQrcode() {
  try {
    loading.value = true;
    msg.value = '获取登录二维码';
    await newLoginSession();
    qrcodeSrc.value = `/api/web/login/getqrcode?rnd=${Math.random()}`;
    msg.value = '';

    // 启动计时器开始轮训检查
    _check();
  } catch (e: any) {
    msg.value = e.message;
    qrcodeSrc.value = 'https://placehold.co/320?text=qrcode';
  } finally {
    loading.value = false;
  }
}

function _check() {
  window.clearTimeout(checkTimer.value!);

  if (modal.isOpen.value) {
    checkTimer.value = window.setTimeout(checkQrcodeStatus, 2000);
  }
}

// 检查二维码扫描状态
async function checkQrcodeStatus() {
  const resp = await request<ScanLoginResult>('/api/web/login/scan');
  if (resp && resp.base_resp && resp.base_resp.ret === 0) {
    switch (resp.status) {
      case 0:
        _check();
        break;
      case 1:
        // 登录成功
        msg.value = '已确认，正在登录中';
        await bizLogin();
        break;
      case 2:
      case 3:
        // 刷新二维码
        qrcodeSrc.value = `/api/web/login/getqrcode?rnd=${Math.random()}`;
        _check();
        break;
      case 4:
      case 6:
        if (resp.acct_size >= 1) {
          loading.value = true;
          msg.value = '扫码成功，等待确认';
          qrcodeSrc.value = '';
        } else {
          msg.value = '没有可登录账号';
        }
        _check();
        break;
      case 5:
        // 未绑定邮箱，不能扫描登录
        msg.value = '该账号尚未绑定邮箱';
        _check();
        break;
    }
  }
}

async function bizLogin() {
  try {
    loading.value = true;
    const resp = await request<LoginAccount>('/api/web/login/bizlogin', {
      method: 'POST',
    });
    if (resp.err) {
      throw new Error(`${resp.err}`);
    }

    msg.value = '登录成功';
    // 登录身份变化时，后续账号列表只允许读写当前身份的本地缓存作用域。
    // 旧作用域数据保留在 IndexedDB 中，但不会再拿新会话去同步旧 fakeid。
    setCurrentAccountOwnerKey(createAccountOwnerKey(resp));
    loginAccount.value = resp;

    closeModal();
  } catch (e: any) {
    msg.value = e.message;
  } finally {
    loading.value = false;
  }
}

async function passwordLogin() {
  if (!username.value.trim()) {
    msg.value = '请输入账号';
    return;
  }
  if (!password.value) {
    msg.value = '请输入密码';
    return;
  }

  try {
    loading.value = true;
    msg.value = '正在登录';
    const resp = await request<LoginAccount>('/api/web/login/password', {
      method: 'POST',
      body: {
        username: username.value,
        password: password.value,
      },
    });
    if (resp.err) {
      throw new Error(resp.err);
    }

    setCurrentAccountOwnerKey(createAccountOwnerKey(resp));
    loginAccount.value = resp;
    password.value = '';
    msg.value = '登录成功';
    closeModal();
  } catch (e: any) {
    password.value = '';
    msg.value = e?.message || '账号密码登录失败，请改用二维码登录';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <UModal prevent-close>
    <UCard>
      <template #header>
        <h2 class="text-lg font-semibold">登录微信公众号</h2>
        <UButton
          square
          variant="link"
          color="gray"
          icon="i-lucide:x"
          class="absolute right-3 top-3"
          @click="closeModal"
        />
      </template>

      <div class="mb-4 flex gap-2">
        <UButton
          :variant="loginMode === 'qrcode' ? 'solid' : 'soft'"
          :disabled="loading"
          @click="switchLoginMode('qrcode')"
        >
          扫描二维码
        </UButton>
        <UButton
          :variant="loginMode === 'password' ? 'solid' : 'soft'"
          :disabled="loading"
          @click="switchLoginMode('password')"
        >
          账号密码
        </UButton>
      </div>

      <!-- 二维码图片展示区 -->
      <div v-if="loginMode === 'qrcode'" class="flex flex-col justify-center items-center mx-auto size-80">
        <UIcon v-if="loading" name="i-lucide:loader" :size="28" class="animate-spin text-slate-500" />
        <p v-if="msg" class="text-rose-500">{{ msg }}</p>
        <img v-if="qrcodeSrc" :src="qrcodeSrc" alt="微信公众平台登录二维码" class="w-full rounded-md" />
      </div>

      <form v-else class="space-y-4" @submit.prevent="passwordLogin">
        <UFormGroup label="账号" name="username">
          <UInput v-model="username" autocomplete="username" placeholder="邮箱或微信公众平台账号" :disabled="loading" />
        </UFormGroup>
        <UFormGroup label="密码" name="password">
          <UInput
            v-model="password"
            type="password"
            autocomplete="current-password"
            placeholder="请输入密码"
            :disabled="loading"
          />
        </UFormGroup>
        <p class="text-xs text-slate-500">微信要求验证码或安全确认时，请切换为二维码登录完成验证。</p>
        <UButton type="submit" block :loading="loading">登录</UButton>
        <p v-if="msg" class="text-rose-500">{{ msg }}</p>
      </form>
    </UCard>
  </UModal>
</template>
