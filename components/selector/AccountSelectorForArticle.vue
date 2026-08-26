<template>
  <USelectMenu
    v-model="selected"
    size="md"
    color="gray"
    multiple
    searchable
    searchable-placeholder="筛选公众号..."
    clear-search-on-close
    :options="sortedAccountInfos"
    option-attribute="nickname"
    placeholder="请选择公众号"
  >
    <template #label>
      <template v-if="selected.length === 1">
        <UAvatar :src="selected[0].round_head_img" size="2xs" />
        <span class="max-w-30 line-clamp-1">{{ selected[0].nickname }}</span>
        <span class="shrink-0">({{ selected[0].articles }}篇)</span>
      </template>
      <span v-else-if="selected.length > 1">已选择 {{ selected.length }} 个公众号</span>
      <span v-else>请选择公众号</span>
    </template>
    <template #option="{ option: account }">
      <UAvatar :src="account.round_head_img" size="sm" />
      <div>
        <p class="text-[16px]">{{ account.nickname }}</p>
        <p class="text-gray-500 text-sm">已加载文章数: {{ account.articles }}</p>
      </div>
    </template>
    <template #option-empty="{ query }">
      未找到匹配「{{ query }}」的公众号<br />请先在「<NuxtLink
        to="/dashboard/account"
        class="text-blue-500 hover:underline"
        >公众号管理</NuxtLink
      >」中添加
    </template>
    <template #empty>
      暂无公众号，请先在「<NuxtLink to="/dashboard/account" class="text-blue-500 hover:underline">公众号管理</NuxtLink
      >」中添加
    </template>
  </USelectMenu>
</template>

<script setup lang="ts">
import { getAllInfo, type MpAccount } from '~/store/v2/info';

// 已缓存的公众号信息
const cachedAccountInfos = await getAllInfo();
const sortedAccountInfos = computed(() => {
  cachedAccountInfos.sort((a, b) => {
    return a.articles > b.articles ? -1 : 1;
  });
  return cachedAccountInfos;
});

const selected = defineModel<MpAccount[]>({ default: [] });
</script>
