<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useKbStore } from '@/stores/kb'
import { useGovernanceStore } from '@/stores/governance'
import { formatDate, formatFull, avatarColor } from '@/utils/format'
import {
  GOV, govTypeLabel, govTypeIcon, govStageLabel, govStatusLabel, govStatusCls,
  assignRoleLabel, isActionable, isEventOverdue, canActOnEvent, canTransferEvent,
  routeOf, failReasonLabel, govTimelineLabel, slaOf
} from '@/utils/governance'

const router = useRouter()
const auth = useAuthStore()
const kb = useKbStore()
const gov = useGovernanceStore()

const tab = ref('mine') // mine | all | overdue | failed | history
const busyId = ref('')
const noteMap = ref({})
const transferFor = ref('') // 展开转交面板的事件 id
const transferTarget = ref('')
const syncing = ref(false)

const userById = computed(() => Object.fromEntries(auth.users.map((u) => [u.id, u])))
const docById = computed(() => Object.fromEntries(kb.docs.map((d) => [d.id, d])))

const sorted = computed(() =>
  [...gov.events].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
)

const mine = computed(() => gov.todosFor(auth.user))
const allOpen = computed(() =>
  sorted.value.filter((e) => e.status === GOV.OPEN || e.status === GOV.CLAIMED)
)
const overdue = computed(() => allOpen.value.filter((e) => e.timedOut || isEventOverdue(e)))
const failed = computed(() => sorted.value.filter((e) => e.status === GOV.FAILED))
const history = computed(() =>
  sorted.value.filter((e) => e.status === GOV.DONE || e.status === GOV.CANCELLED)
)

const list = computed(() => {
  if (tab.value === 'mine') return mine.value
  if (tab.value === 'all') return allOpen.value
  if (tab.value === 'overdue') return overdue.value
  if (tab.value === 'failed') return failed.value
  return history.value
})

const counts = computed(() => ({
  mine: mine.value.length,
  all: allOpen.value.length,
  overdue: overdue.value.length,
  failed: failed.value.length,
  history: history.value.length
}))

// 可执行的一键动作（按事件类型/阶段）
function actionsOf(ev) {
  const key = ev.type + ':' + ev.stage
  if (key === 'review:approve') return [{ act: 'approve', label: '✓ 通过并发布', cls: 'ok-solid' }, { act: 'reject', label: '✕ 驳回', cls: '' }]
  if (key === 'correction:claim') return [{ act: 'claim', label: '✋ 认领纠错单', cls: 'ok-solid' }]
  if (key === 'handover:confirm') return [{ act: 'confirm', label: '✓ 确认接收', cls: 'ok-solid' }]
  if (key === 'handover:approve') return [{ act: 'approve', label: '✓ 批准转移', cls: 'ok-solid' }, { act: 'reject', label: '✕ 驳回', cls: '' }]
  if (key === 'retirement:approve') return [{ act: 'approve', label: '✓ 批准退役', cls: 'ok-solid' }, { act: 'reject', label: '✕ 驳回', cls: '' }]
  if (key === 'release:approve') return [{ act: 'approve', label: '✓ 放行发布', cls: 'ok-solid' }, { act: 'reject', label: '✕ 驳回', cls: '' }]
  return []
}

// 当前用户能否处理该事件（按钮展示与 store 事务内复核同源）
function canHandle(ev) {
  if (ev.status === GOV.CLAIMED) return ev.claimedBy === auth.user?.id || auth.user?.role === 'admin'
  if (ev.status === GOV.OPEN) return canActOnEvent(ev, auth.user)
  return false
}

// 转交候选成员：满足事件角色门槛且非当前处理人
function transferCandidates(ev) {
  return auth.users.filter((u) => {
    if (u.id === auth.user?.id || u.id === ev.claimedBy) return false
    if (ev.assigneeRole === 'admin') return u.role === 'admin'
    if (ev.assigneeRole === 'editor') return u.role === 'admin' || u.role === 'editor'
    return true
  })
}

async function refresh() {
  if (syncing.value) return
  syncing.value = true
  try {
    await gov.syncEvents()
    await gov.sweepTimeouts()
  } finally {
    syncing.value = false
  }
}

async function claim(ev) {
  if (busyId.value) return
  busyId.value = ev.id
  try {
    const r = await gov.claimEvent(ev.id, auth.user)
    if (r.status !== 'ok') alert(r.status === 'denied' ? '没有认领该待办的权限。' : '待办状态已变化，请刷新。')
  } finally {
    busyId.value = ''
  }
}

async function release(ev) {
  if (busyId.value) return
  busyId.value = ev.id
  try {
    await gov.releaseEvent(ev.id, auth.user)
  } finally {
    busyId.value = ''
  }
}

async function complete(ev, act) {
  if (busyId.value) return
  busyId.value = ev.id
  try {
    const r = await gov.completeEvent(ev.id, act, (noteMap.value[ev.id] || '').trim(), auth.user)
    if (r.status === 'ok') {
      noteMap.value[ev.id] = ''
    } else if (r.status === 'failed') {
      alert('回写原流程失败：' + failReasonLabel(r.reason) + '。事件已标记为失败，可在「失败待重试」中重试。')
      tab.value = 'failed'
    } else if (r.status === 'denied' || r.status === 'guest') {
      alert('没有处理该待办的权限。')
    } else {
      alert('待办状态已变化，请刷新。')
    }
  } finally {
    busyId.value = ''
  }
}

async function retry(ev) {
  if (busyId.value) return
  busyId.value = ev.id
  try {
    const act = actionsOf(ev)[0]?.act || 'approve'
    const r = await gov.retryEvent(ev.id, act, (noteMap.value[ev.id] || '').trim(), auth.user)
    if (r.status === 'ok') noteMap.value[ev.id] = ''
    else if (r.status === 'failed') alert('重试仍失败：' + failReasonLabel(r.reason))
    else if (r.status === 'denied') alert('没有重试该待办的权限。')
    else alert('待办状态已变化，请刷新。')
  } finally {
    busyId.value = ''
  }
}

async function doTransfer(ev) {
  if (busyId.value || !transferTarget.value) return
  const target = auth.users.find((u) => u.id === transferTarget.value)
  if (!target) return
  busyId.value = ev.id
  try {
    const r = await gov.transferEvent(ev.id, target, '', auth.user)
    if (r.status === 'ok') {
      transferFor.value = ''
      transferTarget.value = ''
    } else if (r.status === 'locked') alert('该待办由源流程指定处理人，不可转交。')
    else if (r.status === 'bad-target') alert('目标成员不满足该待办的角色要求。')
    else alert('转交失败：待办状态已变化。')
  } finally {
    busyId.value = ''
  }
}

function goHandle(ev) {
  router.push(routeOf(ev))
}

function goDoc(ev) {
  if (ev.docId && docById.value[ev.docId]) router.push('/docs/' + ev.docId)
}

onMounted(async () => {
  await gov.loadAll()
  await refresh()
})
</script>

<template>
  <div class="tc-page">
    <header class="head">
      <h2>✅ 统一待办中心</h2>
      <p class="sub">
        汇聚评审、纠错、保鲜、交接、退役、发布门禁六类治理事件，按角色分派；支持认领、转交、超时升级与失败重试，
        可一键回写原流程状态。各类待办 SLA：评审/交接/退役 72h · 纠错/门禁 48h · 保鲜 96h。
      </p>
      <div class="tabs">
        <button :class="{ on: tab === 'mine' }" @click="tab = 'mine'">我的待办 <em>{{ counts.mine }}</em></button>
        <button :class="{ on: tab === 'all' }" @click="tab = 'all'">全部待处理 <em>{{ counts.all }}</em></button>
        <button :class="{ on: tab === 'overdue' }" @click="tab = 'overdue'">已超时 <em>{{ counts.overdue }}</em></button>
        <button :class="{ on: tab === 'failed' }" @click="tab = 'failed'">失败待重试 <em>{{ counts.failed }}</em></button>
        <button :class="{ on: tab === 'history' }" @click="tab = 'history'">历史记录 <em>{{ counts.history }}</em></button>
        <button class="sync" :disabled="syncing" @click="refresh">{{ syncing ? '同步中…' : '⟳ 同步事件' }}</button>
      </div>
    </header>

    <div v-if="!list.length" class="empty card">
      <div class="ico">📭</div>
      {{ tab === 'mine' ? '暂无指派给你的待办' : tab === 'overdue' ? '没有超时待办' : tab === 'failed' ? '没有回写失败的待办' : tab === 'history' ? '暂无历史记录' : '暂无待处理事件' }}
    </div>

    <div v-else class="ev-list">
      <div v-for="ev in list" :key="ev.id" class="ev card" :class="{ 'is-timeout': ev.timedOut && (ev.status === 'open' || ev.status === 'claimed') }">
        <div class="ev-top">
          <div class="ev-main">
            <span class="ev-ico">{{ govTypeIcon(ev.type) }}</span>
            <span class="ev-title" :class="{ link: ev.docId && docById[ev.docId] }" @click="goDoc(ev)">{{ ev.title }}</span>
            <span class="ev-type">{{ govTypeLabel(ev.type) }} · {{ govStageLabel(ev.stage) }}</span>
          </div>
          <div class="ev-side">
            <span v-if="ev.timedOut && (ev.status === 'open' || ev.status === 'claimed')" class="timeout-tag">⏰ 已超时</span>
            <span class="st" :class="govStatusCls(ev.status)">{{ govStatusLabel(ev.status) }}</span>
          </div>
        </div>

        <div class="ev-info">
          <span class="assign">分派：{{ assignRoleLabel(ev) }}<template v-if="ev.assigneeId">（{{ userById[ev.assigneeId]?.name || ev.assigneeId }}）</template></span>
          <span v-if="ev.claimedBy" class="who">
            <span class="ava" :style="{ background: avatarColor(ev.claimedBy) }">{{ userById[ev.claimedBy]?.avatar || '?' }}</span>
            {{ userById[ev.claimedBy]?.name || ev.claimedBy }} 处理中
          </span>
          <span class="due" :class="{ over: isEventOverdue(ev) }">截止 {{ formatFull(ev.dueAt) }}（{{ formatDate(ev.dueAt) }}）</span>
          <span v-if="ev.attempts" class="attempts">重开/重试 {{ ev.attempts }} 次</span>
          <span class="sla">SLA {{ slaOf(ev.type) }}h</span>
        </div>

        <div v-if="ev.status === 'failed'" class="fail-box">
          回写失败：{{ failReasonLabel(ev.failReason) }}（{{ userById[ev.failBy]?.name || ev.failBy }} · {{ formatFull(ev.failAt) }}）
        </div>
        <div v-if="ev.writeback" class="wb-box">
          已回写原流程：{{ ev.writeback.target }} · {{ ev.writeback.action }}（{{ userById[ev.writeback.by]?.name || ev.writeback.by }} · {{ formatFull(ev.writeback.at) }}）
        </div>
        <div v-if="ev.result && (ev.status === 'done' || ev.status === 'cancelled')" class="result-box">
          结论：{{ ev.result }}<template v-if="ev.doneBy"> · {{ userById[ev.doneBy]?.name || ev.doneBy }} · {{ formatFull(ev.doneAt) }}</template>
        </div>

        <!-- 待处理/处理中：操作区 -->
        <div v-if="(ev.status === 'open' || ev.status === 'claimed') && (canHandle(ev) || isActionable(ev))" class="ops">
          <template v-if="ev.status === 'open' && canHandle(ev)">
            <button class="btn sm" :disabled="busyId === ev.id" @click="claim(ev)">认领</button>
          </template>
          <template v-if="ev.status === 'claimed' && (ev.claimedBy === auth.user?.id || auth.user?.role === 'admin')">
            <button class="btn sm" :disabled="busyId === ev.id" @click="release(ev)">释放</button>
          </template>
          <button v-if="canTransferEvent(ev, auth.user)" class="btn sm" :disabled="busyId === ev.id" @click="transferFor = transferFor === ev.id ? '' : ev.id; transferTarget = ''">转交</button>
          <button v-if="!isActionable(ev)" class="btn sm primary" @click="goHandle(ev)">前往处理 →</button>
        </div>

        <!-- 一键回写动作 -->
        <div v-if="isActionable(ev) && (ev.status === 'open' || ev.status === 'claimed') && canHandle(ev)" class="act-box">
          <textarea v-model="noteMap[ev.id]" rows="2" placeholder="处理意见（可选，随回写写入原流程留痕）"></textarea>
          <div class="act-actions">
            <button v-for="a in actionsOf(ev)" :key="a.act" class="btn sm" :class="a.cls" :disabled="busyId === ev.id" @click="complete(ev, a.act)">{{ a.label }}</button>
          </div>
        </div>

        <!-- 失败重试 -->
        <div v-if="ev.status === 'failed' && (ev.failBy === auth.user?.id || auth.user?.role === 'admin' || canActOnEvent(ev, auth.user))" class="act-box">
          <textarea v-model="noteMap[ev.id]" rows="2" placeholder="重试意见（可选）"></textarea>
          <div class="act-actions">
            <button class="btn sm ok-solid" :disabled="busyId === ev.id" @click="retry(ev)">↻ 重试回写</button>
            <button class="btn sm" @click="goHandle(ev)">前往原流程处理 →</button>
          </div>
        </div>

        <!-- 转交面板 -->
        <div v-if="transferFor === ev.id" class="transfer-box">
          <select v-model="transferTarget">
            <option value="" disabled>选择转交成员…</option>
            <option v-for="u in transferCandidates(ev)" :key="u.id" :value="u.id">{{ u.name }}（{{ u.role === 'admin' ? '管理员' : u.role === 'editor' ? '编辑者' : '只读' }}）</option>
          </select>
          <button class="btn sm primary" :disabled="!transferTarget || busyId === ev.id" @click="doTransfer(ev)">确认转交</button>
          <button class="btn sm" @click="transferFor = ''">取消</button>
        </div>

        <details class="timeline">
          <summary>留痕（{{ (ev.timeline || []).length }}）</summary>
          <div v-for="(t, i) in ev.timeline || []" :key="i" class="tl">
            <span class="tl-act">{{ govTimelineLabel(t.action) }}</span>
            <span class="tl-who">{{ userById[t.by]?.name || (t.by === 'system' ? '系统' : t.by) }}</span>
            <span v-if="t.note" class="tl-note">“{{ t.note }}”</span>
            <span class="tl-tm">{{ formatFull(t.at) }}</span>
          </div>
        </details>
      </div>
    </div>

    <p class="foot-tip">待办事件由「同步事件」从六个治理流程实时汇聚（dedupeKey 去重）；源流程状态推进后待办自动闭环，源回退时待办重开。</p>
  </div>
</template>

<style scoped>
.tc-page { max-width: 920px; margin: 0 auto; }
.head h2 { margin: 0 0 4px; }
.sub { color: var(--text-2); font-size: 13px; margin: 0 0 14px; }
.tabs { display: flex; gap: 8px; flex-wrap: wrap; }
.tabs button { border: 1px solid var(--border); background: var(--panel); padding: 7px 16px; border-radius: 999px; cursor: pointer; font-size: 13px; color: var(--text-2); }
.tabs button.on { background: var(--primary); border-color: var(--primary); color: #fff; font-weight: 600; }
.tabs em { font-style: normal; opacity: 0.7; margin-left: 2px; }
.tabs .sync { margin-left: auto; color: var(--primary); border-color: var(--primary); }
.ev-list { display: flex; flex-direction: column; gap: 12px; margin-top: 16px; }
.ev { padding: 16px 20px; }
.ev.is-timeout { border-color: #fca5a5; }
.ev-top { display: flex; justify-content: space-between; gap: 14px; }
.ev-main { min-width: 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ev-ico { font-size: 16px; }
.ev-title { font-weight: 700; font-size: 14px; }
.ev-title.link { cursor: pointer; color: var(--primary); }
.ev-type { font-size: 11px; padding: 1px 9px; border-radius: 999px; background: var(--panel-2); color: var(--text-3); }
.ev-side { display: flex; align-items: center; gap: 8px; white-space: nowrap; }
.timeout-tag { font-size: 11px; padding: 1px 9px; border-radius: 999px; background: #fee2e2; color: #b91c1c; font-weight: 600; }
.st { font-size: 12px; padding: 2px 10px; border-radius: 999px; }
.st-open { background: #fef3c7; color: #b45309; }
.st-claimed { background: #dbeafe; color: #1d4ed8; }
.st-done { background: #dcfce7; color: #15803d; }
.st-off { background: var(--panel-2); color: var(--text-3); }
.st-failed { background: #fee2e2; color: #b91c1c; }
.ev-info { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-top: 10px; font-size: 12px; color: var(--text-2); }
.who { display: inline-flex; align-items: center; gap: 6px; }
.ava { width: 20px; height: 20px; border-radius: 50%; color: #fff; font-size: 10px; display: inline-grid; place-items: center; }
.due.over { color: #b91c1c; font-weight: 600; }
.attempts { color: #b45309; }
.sla { color: var(--text-3); }
.fail-box { margin-top: 10px; font-size: 12px; color: #b91c1c; background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 6px 12px; }
.wb-box { margin-top: 10px; font-size: 12px; color: #15803d; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 6px 12px; }
.result-box { margin-top: 10px; font-size: 12px; color: var(--text-2); background: var(--panel-2); border-radius: 8px; padding: 6px 12px; }
.ops { display: flex; gap: 8px; margin-top: 12px; }
.act-box { margin-top: 12px; border-top: 1px dashed var(--border); padding-top: 12px; }
.act-box textarea { width: 100%; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px 10px; font-size: 13px; resize: vertical; outline: none; }
.act-box textarea:focus { border-color: var(--primary); }
.act-actions { display: flex; gap: 8px; margin-top: 8px; }
.btn.ok-solid { background: #16a34a; border-color: #16a34a; color: #fff; }
.btn.ok-solid:hover { background: #15803d; color: #fff; }
.btn.primary { background: var(--primary); border-color: var(--primary); color: #fff; }
.transfer-box { display: flex; gap: 8px; margin-top: 10px; align-items: center; }
.transfer-box select { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 6px 10px; font-size: 13px; background: var(--panel); }
.timeline { margin-top: 10px; }
.timeline summary { cursor: pointer; font-size: 12px; color: var(--text-3); }
.tl { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; padding: 4px 0; font-size: 12px; }
.tl-act { font-weight: 600; color: var(--primary); min-width: 130px; }
.tl-who { color: var(--text-2); min-width: 50px; }
.tl-note { color: var(--text-2); flex: 1; }
.tl-tm { color: var(--text-3); }
.empty { padding: 40px; text-align: center; color: var(--text-3); }
.empty .ico { font-size: 28px; margin-bottom: 8px; }
.foot-tip { margin-top: 14px; color: var(--text-3); font-size: 12px; text-align: center; }
</style>
