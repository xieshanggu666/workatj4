<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useCorrectionStore } from '@/stores/correction'
import {
  CORRECTION, CORRECTION_TYPES, correctionTypeLabel, correctionStatusLabel, correctionStatusCls,
  correctionTimelineLabel, canCreateCorrection
} from '@/utils/correction'
import { formatFull, formatDate, avatarColor } from '@/utils/format'

const props = defineProps({ doc: { type: Object, required: true } })
const router = useRouter()
const auth = useAuthStore()
const correctionStore = useCorrectionStore()

const showForm = ref(false)
const formType = ref('factual')
const formDesc = ref('')
const formExpected = ref('')
const submitting = ref(false)
const doneId = ref('')
const showAll = ref(false)

const tickets = computed(() => correctionStore.ticketsOfDoc(props.doc.id))
const openTickets = computed(() => tickets.value.filter((t) =>
  t.status === CORRECTION.SUBMITTED || t.status === CORRECTION.CLAIMED || t.status === CORRECTION.IN_REVIEW))
const visibleTickets = computed(() => showAll.value ? tickets.value : openTickets.value.slice(0, 3))
const userById = computed(() => Object.fromEntries(auth.users.map((u) => [u.id, u])))
const canSubmit = computed(() => canCreateCorrection(auth.user))
// 当前用户在本文档已提交且仍在途的纠错单（防重复打扰）
const myOpen = computed(() =>
  openTickets.value.filter((t) => t.createdBy === auth.user?.id))

async function submitCorrection() {
  const desc = formDesc.value.trim()
  if (!desc || submitting.value) return
  submitting.value = true
  try {
    const res = await correctionStore.createTicket({
      docId: props.doc.id, type: formType.value, description: desc,
      expected: formExpected.value.trim(), source: 'doc'
    }, auth.user)
    if (res.status === 'ok') {
      doneId.value = res.ticket.id
      showForm.value = false
      formDesc.value = ''
      formExpected.value = ''
      setTimeout(() => { doneId.value = '' }, 5000)
    } else if (res.status === 'duplicate') {
      alert('你已提交过相同描述的在途纠错单，可在「知识纠错」中心追踪处理状态。')
    } else if (res.status === 'guest') {
      alert('访客不能提交纠错，请先登录。')
    } else {
      alert('提交失败，请稍后重试。')
    }
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="cor-panel card">
    <div class="cp-head">
      <span class="cp-title">🐞 知识纠错<em v-if="openTickets.length" class="cp-count">{{ openTickets.length }} 处理中</em></span>
      <button v-if="canSubmit && !showForm" class="btn sm" @click="showForm = true">📣 报错</button>
    </div>

    <!-- 报错提交表单：成员发现文档错误并关联本文档 -->
    <div v-if="showForm" class="cp-form">
      <div class="cp-f-row">
        <label>错误类型</label>
        <div class="type-chips">
          <span v-for="tp in CORRECTION_TYPES" :key="tp.key" class="type-chip"
                :class="{ on: formType === tp.key }" @click="formType = tp.key">{{ tp.label }}</span>
        </div>
      </div>
      <div class="cp-f-row">
        <label>错误描述</label>
        <textarea v-model="formDesc" rows="3" placeholder="指出错误位置与问题，例如：第 2 节的安装命令缺少 -D 参数…"></textarea>
      </div>
      <div class="cp-f-row">
        <label>期望内容</label>
        <textarea v-model="formExpected" rows="2" placeholder="正确应该是什么（可选，便于编辑者修订）…"></textarea>
      </div>
      <div class="cp-f-acts">
        <button class="btn sm primary" :disabled="!formDesc.trim() || submitting" @click="submitCorrection">
          {{ submitting ? '提交中…' : '提交纠错' }}
        </button>
        <button class="btn sm ghost" @click="showForm = false">取消</button>
        <span class="cp-f-hint">提交后进入「待处理」，编辑者认领修订并送审，管理员审批通过后回写新版本，你可在纠错中心追踪全程。</span>
      </div>
    </div>

    <div v-if="doneId" class="cp-done">✅ 纠错已提交并关联本文档，可在「知识纠错 → 我提交的」追踪处理状态。</div>

    <!-- 本文档纠错单 -->
    <div v-if="visibleTickets.length" class="cp-list">
      <div v-for="t in visibleTickets" :key="t.id" class="cp-item" :class="'is-' + t.status">
        <div class="cp-item-top">
          <span class="cp-type">{{ correctionTypeLabel(t.type) }}</span>
          <span class="st" :class="correctionStatusCls(t.status)">{{ correctionStatusLabel(t.status) }}</span>
        </div>
        <div class="cp-desc">{{ t.description }}</div>
        <div v-if="t.expected" class="cp-expected">期望：{{ t.expected }}</div>
        <div class="cp-meta">
          <span class="who">
            <span class="ava" :style="{ background: avatarColor(t.createdBy) }">{{ userById[t.createdBy]?.avatar || '?' }}</span>
            {{ userById[t.createdBy]?.name || t.createdBy }}
          </span>
          <span v-if="t.claimedBy" class="who">修订：{{ userById[t.claimedBy]?.name || t.claimedBy }}</span>
          <span class="tm">{{ formatDate(t.createdAt) }}</span>
        </div>
        <div v-if="t.status === CORRECTION.RESOLVED && t.resolvedVersion" class="cp-ver">
          ✅ 已修复并发布为 <b>v{{ t.resolvedVersion }}</b>（{{ formatFull(t.resolvedAt) }}）
        </div>
      </div>
    </div>

    <div v-if="tickets.length > visibleTickets.length || (showAll && tickets.length)" class="cp-more">
      <a v-if="!showAll && tickets.length > 3" @click="showAll = true">查看全部 {{ tickets.length }} 条纠错记录</a>
      <a v-else-if="showAll" @click="showAll = false">收起</a>
    </div>

    <div v-if="!tickets.length && !showForm" class="cp-empty">暂无纠错记录。发现内容有误？点击「报错」提交，修订经审批后自动回写新版本。</div>

    <div class="cp-foot">
      <a @click="router.push('/corrections')">前往知识纠错中心 →</a>
    </div>
  </div>
</template>

<style scoped>
.cor-panel { margin-top: 14px; padding: 16px 24px; }
.cp-head { display: flex; justify-content: space-between; align-items: center; }
.cp-title { font-weight: 600; display: flex; align-items: center; gap: 8px; }
.cp-count { font-style: normal; font-size: 11px; font-weight: 600; padding: 1px 9px; border-radius: 999px; background: #fef2f2; color: #b91c1c; }
.cp-form { margin-top: 12px; border-top: 1px dashed var(--border); padding-top: 12px; display: flex; flex-direction: column; gap: 10px; }
.cp-f-row { display: flex; flex-direction: column; gap: 6px; }
.cp-f-row label { font-size: 12px; color: var(--text-3); }
.cp-f-row textarea { width: 100%; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px 10px; font-size: 13px; resize: vertical; outline: none; }
.cp-f-row textarea:focus { border-color: var(--primary); }
.type-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.type-chip { font-size: 12px; padding: 3px 11px; border-radius: 999px; border: 1px solid var(--border); background: var(--panel-2); cursor: pointer; }
.type-chip.on { background: #fef2f2; border-color: #f87171; color: #b91c1c; font-weight: 600; }
.cp-f-acts { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cp-f-hint { font-size: 11px; color: var(--text-3); flex: 1; min-width: 200px; }
.cp-done { margin-top: 10px; padding: 8px 14px; border-radius: 8px; font-size: 13px; color: #15803d; background: #f0fdf4; border: 1px solid #bbf7d0; }
.cp-list { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; }
.cp-item { border: 1px solid var(--border); border-radius: 10px; padding: 10px 14px; }
.cp-item.is-resolved { background: #fafdf9; }
.cp-item-top { display: flex; justify-content: space-between; align-items: center; }
.cp-type { font-size: 11px; font-weight: 600; color: #b91c1c; }
.st { font-size: 11px; padding: 1px 9px; border-radius: 999px; }
.st-submitted { background: #fef3c7; color: #b45309; }
.st-claimed { background: var(--primary-weak); color: var(--primary); }
.st-review { background: #e0f2fe; color: #0369a1; }
.st-resolved { background: #dcfce7; color: #15803d; }
.st-withdrawn { background: var(--panel-2); color: var(--text-3); }
.cp-desc { margin-top: 6px; font-size: 13px; color: var(--text); }
.cp-expected { margin-top: 4px; font-size: 12px; color: var(--text-2); }
.cp-meta { margin-top: 8px; display: flex; align-items: center; gap: 12px; font-size: 12px; color: var(--text-3); }
.who { display: inline-flex; align-items: center; gap: 5px; }
.ava { width: 18px; height: 18px; border-radius: 50%; color: #fff; font-size: 9px; display: inline-grid; place-items: center; }
.tm { margin-left: auto; }
.cp-ver { margin-top: 6px; font-size: 12px; color: #15803d; }
.cp-more { margin-top: 10px; font-size: 12px; }
.cp-more a { color: var(--primary); cursor: pointer; }
.cp-empty { margin-top: 12px; font-size: 13px; color: var(--text-3); }
.cp-foot { margin-top: 10px; font-size: 12px; text-align: right; }
.cp-foot a { color: var(--primary); cursor: pointer; }
</style>
