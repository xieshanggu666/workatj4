<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useKbStore } from '@/stores/kb'
import { useAuthStore } from '@/stores/auth'
import { useGovernanceStore } from '@/stores/governance'
import DocPill from '@/components/common/DocPill.vue'
import { formatDate, formatFull, avatarColor } from '@/utils/format'
import {
  SYNC_STATE, isGovEventOpen, isGovOverdue,
  canClaimEvent, canAssignEvent, canTransferEvent, canRetryEvent, canCancelEvent,
  govKindLabel, govKindIcon, govStageLabel, govStatusLabel, govStatusCls,
  syncStateLabel, govTimelineLabel, govKindRoute
} from '@/utils/governance'
import { roleLabel } from '@/utils/permission'

const router = useRouter()
const kb = useKbStore()
const auth = useAuthStore()
const gov = useGovernanceStore()

const tab = ref('mine') // mine 待我处理 | open 全部待办 | overdue 已超时 | failed 回写失败 | done 已办结
const busyId = ref('')
const toast = ref('')
const assigningId = ref('') // 正在分派的待办
const assignPick = ref('') // 分派选择：role:admin | role:editor | user:<id>
const transferringId = ref('') // 正在转交的待办
const transferPick = ref('') // 转交目标成员 id

const TABS = [
  { key: 'mine', label: '待我处理' },
  { key: 'open', label: '全部待办' },
  { key: 'overdue', label: '已超时' },
  { key: 'failed', label: '回写失败' },
  { key: 'done', label: '已办结' }
]

const docById = computed(() => Object.fromEntries(kb.docs.map((d) => [d.id, d])))
const userById = computed(() => Object.fromEntries(auth.users.map((u) => [u.id, u])))
const uid = computed(() => auth.user?.id)

const list = computed(() => {
  if (tab.value === 'mine') return gov.actionableFor(auth.user?.id, auth.user?.role)
  if (tab.value === 'open') return gov.openEvents
  if (tab.value === 'overdue') return gov.sorted.filter((e) => isGovOverdue(e, gov.now))
  if (tab.value === 'failed') return gov.sorted.filter((e) => e.syncState === SYNC_STATE.FAILED)
  return gov.sorted.filter((e) => !isGovEventOpen(e))
})

const counts = computed(() => ({
  mine: gov.pendingCountFor(auth.user?.id, auth.user?.role),
  open: gov.openEvents.length,
  overdue: gov.overdueCount,
  failed: gov.failedCount,
  done: gov.events.filter((e) => !isGovEventOpen(e)).length
}))

const emptyText = computed(() => ({
  mine: '暂无待你处理的治理待办',
  open: '暂无在途治理待办',
  overdue: '暂无超时待办',
  failed: '暂无回写失败的待办',
  done: '暂无已办结记录'
}[tab.value]))

// 分派候选项：角色池（管理员/编辑者）+ 全体成员
const assignOptions = computed(() => [
  { value: 'role:admin', label: '角色池 · 管理员' },
  { value: 'role:editor', label: '角色池 · 编辑者' },
  ...auth.users.map((u) => ({ value: 'user:' + u.id, label: '指定成员 · ' + u.name + '（' + roleLabel(u.role) + '）' }))
])

// 转交候选：除当前认领人外的成员
const transferOptions = computed(() => {
  const ev = gov.sorted.find((e) => e.id === transferringId.value)
  return auth.users.filter((u) => u.id !== ev?.claimedBy)
})

function assigneeText(e) {
  if (e.claimedBy) return '处理人：' + (userById.value[e.claimedBy]?.name || e.claimedBy)
  if (e.assigneeId) return '分派给：' + (userById.value[e.assigneeId]?.name || e.assigneeId)
  if (e.assigneeRole) return '角色池：' + roleLabel(e.assigneeRole)
  return '未分派'
}

function showToast(msg) {
  toast.value = msg
  setTimeout(() => { toast.value = '' }, 3000)
}

async function run(id, fn, okMsg) {
  if (busyId.value) return
  busyId.value = id
  try {
    const res = await fn()
    if (res.status === 'ok') showToast(okMsg)
    else if (res.status === 'sync-failed') showToast('已记录：回写原流程失败，可稍后重试')
    else if (res.status === 'diverged') alert('源流程状态已变化，该待办已失效关闭。')
    else if (res.status === 'denied') alert('没有权限执行该操作。')
    else if (res.status === 'bad-target') alert('转交/分派目标不合法（纠错修订待办只能转交给编辑者或管理员）。')
    else alert('操作失败：待办状态已变化，请刷新查看')
  } finally {
    busyId.value = ''
  }
}

async function claim(e) {
  await run(e.id, () => gov.claimEvent(e.id, auth.user), '已认领，源流程已同步')
}

async function confirmAssign(e) {
  const pick = assignPick.value
  if (!pick) return
  const target = pick.startsWith('user:')
    ? { assigneeId: pick.slice(5) }
    : { assigneeRole: pick.slice(5) }
  await run(e.id, async () => {
    const res = await gov.assignEvent(e.id, target, '', auth.user)
    if (res.status === 'ok') { assigningId.value = ''; assignPick.value = '' }
    return res
  }, '已分派')
}

async function confirmTransfer(e) {
  if (!transferPick.value) return
  await run(e.id, async () => {
    const res = await gov.transferEvent(e.id, transferPick.value, '', auth.user)
    if (res.status === 'ok') { transferringId.value = ''; transferPick.value = '' }
    return res
  }, '已转交，源流程已同步')
}

async function retry(e) {
  await run(e.id, () => gov.retryEvent(e.id, auth.user), '重试成功，已回写原流程')
}

async function cancel(e) {
  if (!confirm('确定取消该待办？源流程仍在对应中心继续流转，待办中心不再跟踪。')) return
  await run(e.id, () => gov.cancelEvent(e.id, '', auth.user), '待办已取消')
}

async function refresh() {
  await gov.syncAll()
  showToast('已重新汇聚六大治理流程的最新待办')
}

function goHandle(e) {
  router.push(govKindRoute(e.kind))
}

onMounted(async () => {
  await Promise.all([kb.loadAll(), auth.loadUsers(), gov.loadAll()])
})
</script>

<template>
  <div class="gov-page">
    <header class="head">
      <h2>📋 治理待办中心</h2>
      <p class="sub">
        统一汇聚<strong>评审 / 纠错 / 保鲜 / 交接 / 退役 / 发布门禁</strong>六个治理流程的在途事件，
        按角色或成员<strong>分派</strong>（同一源单据同一步骤只建一条待办，自动去重）；
        支持<strong>认领、转交、超时升级与失败重试</strong>——待办动作会<strong>回写原流程</strong>
        （纠错单状态机直写，其余源单据追加联动留痕），源流程推进后待办自动办结。
      </p>
      <div class="tabs">
        <button v-for="t in TABS" :key="t.key" :class="{ on: tab === t.key }" @click="tab = t.key">
          {{ t.label }} <em>{{ counts[t.key] }}</em>
        </button>
        <button class="refresh" title="重新汇聚六大治理流程的最新待办" @click="refresh">⟳ 重新汇聚</button>
      </div>
    </header>

    <div v-if="toast" class="card toast-line">✅ {{ toast }}</div>

    <div v-if="!list.length" class="empty card">
      <div class="ico">📋</div>
      {{ emptyText }}
    </div>

    <div v-else class="ev-list">
      <div v-for="e in list" :key="e.id" class="ev card" :class="{ 'is-overdue': isGovOverdue(e, gov.now), 'is-failed': e.syncState === SYNC_STATE.FAILED }">
        <div class="ev-top">
          <div class="ev-title">
            <span class="kind-tag">{{ govKindIcon(e.kind) }} {{ govKindLabel(e.kind) }} · {{ govStageLabel(e.stage) }}</span>
            <span class="ttl">{{ e.title }}</span>
          </div>
          <div class="ev-side">
            <span class="st" :class="govStatusCls(e.status)">{{ govStatusLabel(e.status) }}</span>
            <span class="ev-time">{{ formatDate(e.createdAt) }}</span>
          </div>
        </div>

        <div v-if="e.summary" class="ev-summary">{{ e.summary }}</div>

        <div class="ev-info">
          <span class="who">
            <span class="ava" :style="{ background: avatarColor(e.claimedBy || e.assigneeId || e.assigneeRole || '') }">
              {{ (userById[e.claimedBy || e.assigneeId]?.avatar) || '·' }}
            </span>
            {{ assigneeText(e) }}
          </span>
          <span v-if="e.assignedManually" class="manual-tag">手动分派</span>
          <span v-if="isGovEventOpen(e) && e.dueAt" class="sla" :class="{ over: isGovOverdue(e, gov.now) }">
            ⏱ {{ isGovOverdue(e, gov.now) ? '已超时' : '时限至' }} {{ formatFull(e.dueAt) }}
          </span>
          <span v-if="e.escalatedAt" class="escalated-tag">⚠ 已超时升级</span>
          <span v-if="e.syncState === SYNC_STATE.FAILED" class="sync-tag fail">⚠ {{ syncStateLabel(e.syncState) }}（{{ e.attempts }} 次尝试）</span>
          <span v-else-if="e.syncState === SYNC_STATE.SYNCED" class="sync-tag ok">✓ {{ syncStateLabel(e.syncState) }}</span>
          <span v-if="e.doneReason" class="done-reason">{{ e.doneReason }}</span>
        </div>

        <div v-if="e.lastError && e.syncState === SYNC_STATE.FAILED" class="err-box">
          回写失败：{{ e.lastError }}；点击「重试」重新执行挂起的回写动作，源流程已变化时待办将自动关闭。
        </div>

        <div v-if="e.docId && docById[e.docId]" class="linked-doc" @click="router.push('/docs/' + e.docId)">
          📄 关联文档：<span class="lk-title">《{{ docById[e.docId].title }}》</span>
          <DocPill :doc="docById[e.docId]" />
          <span class="go">查看 →</span>
        </div>
        <div v-else-if="e.docId" class="linked-doc missing">📄 关联文档已删除</div>

        <!-- 操作区 -->
        <div v-if="isGovEventOpen(e)" class="acts">
          <button v-if="canClaimEvent(e, auth.user)" class="btn sm primary" :disabled="busyId === e.id" @click="claim(e)">🙋 认领</button>
          <button v-if="canRetryEvent(e, auth.user)" class="btn sm primary" :disabled="busyId === e.id" @click="retry(e)">🔁 重试回写</button>
          <button v-if="canAssignEvent(e, auth.user)" class="btn sm" :disabled="busyId === e.id" @click="assigningId = assigningId === e.id ? '' : e.id; assignPick = ''">📌 分派</button>
          <button v-if="canTransferEvent(e, auth.user)" class="btn sm" :disabled="busyId === e.id" @click="transferringId = transferringId === e.id ? '' : e.id; transferPick = ''">🔀 转交</button>
          <button class="btn sm ghost" @click="goHandle(e)">去处理 →</button>
          <button v-if="canCancelEvent(e, auth.user)" class="btn sm ghost" :disabled="busyId === e.id" @click="cancel(e)">取消待办</button>
        </div>

        <!-- 分派面板 -->
        <div v-if="assigningId === e.id" class="assign-box">
          <select v-model="assignPick">
            <option value="" disabled>选择分派目标（角色池或指定成员）…</option>
            <option v-for="o in assignOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
          <div class="acts-inline">
            <button class="btn sm primary" :disabled="!assignPick || busyId === e.id" @click="confirmAssign(e)">确认分派</button>
            <button class="btn sm ghost" @click="assigningId = ''">取消</button>
          </div>
        </div>

        <!-- 转交面板 -->
        <div v-if="transferringId === e.id" class="assign-box">
          <select v-model="transferPick">
            <option value="" disabled>选择接手成员…</option>
            <option v-for="u in transferOptions" :key="u.id" :value="u.id">{{ u.name }}（{{ roleLabel(u.role) }}）</option>
          </select>
          <div class="acts-inline">
            <button class="btn sm primary" :disabled="!transferPick || busyId === e.id" @click="confirmTransfer(e)">确认转交</button>
            <button class="btn sm ghost" @click="transferringId = ''">取消</button>
          </div>
          <div class="lk-hint">纠错「待送审」待办的转交会同步回写纠错单的认领关系（原修订人释放 → 新修订人认领）。</div>
        </div>

        <details class="timeline">
          <summary>流转记录（{{ (e.timeline || []).length }}）</summary>
          <div v-for="(en, i) in e.timeline || []" :key="i" class="tl">
            <span class="tl-act">{{ govTimelineLabel(en.action) }}</span>
            <span class="tl-who">{{ en.by === 'system' ? '系统' : (userById[en.by]?.name || en.by) }}</span>
            <span v-if="en.note" class="tl-note">“{{ en.note }}”</span>
            <span class="tl-tm">{{ formatFull(en.at) }}</span>
          </div>
        </details>
      </div>
    </div>

    <p class="foot-tip">待办是六个治理流程的统一投影：在对应中心办结源流程后，待办会在下次汇聚时自动办结。</p>
  </div>
</template>

<style scoped>
.gov-page { max-width: 920px; margin: 0 auto; padding-bottom: 40px; }
.head h2 { margin: 0 0 4px; }
.sub { color: var(--text-2); font-size: 13px; margin: 0 0 14px; }
.sub strong { color: var(--primary); }
.tabs { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.tabs button { border: 1px solid var(--border); background: var(--panel); padding: 7px 16px; border-radius: 999px; cursor: pointer; font-size: 13px; color: var(--text-2); }
.tabs button.on { background: var(--primary); border-color: var(--primary); color: #fff; font-weight: 600; }
.tabs em { font-style: normal; opacity: 0.7; margin-left: 2px; }
.tabs .refresh { margin-left: auto; color: var(--primary); }
.toast-line { margin-top: 14px; padding: 10px 18px; font-size: 13px; color: #15803d; background: #f0fdf4; border-color: #16a34a; }
.ev-list { display: flex; flex-direction: column; gap: 12px; margin-top: 16px; }
.ev { padding: 16px 20px; }
.ev.is-overdue { border-color: #f59e0b; }
.ev.is-failed { border-color: var(--danger); }
.ev-top { display: flex; justify-content: space-between; gap: 14px; }
.ev-title { font-weight: 700; font-size: 15px; min-width: 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ttl { min-width: 0; }
.kind-tag { font-size: 11px; font-weight: 600; padding: 2px 9px; border-radius: 999px; background: var(--primary-weak); color: var(--primary); white-space: nowrap; }
.ev-side { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; white-space: nowrap; }
.st { font-size: 12px; padding: 2px 10px; border-radius: 999px; }
.st-open { background: #fef3c7; color: #b45309; }
.st-claimed { background: var(--primary-weak); color: var(--primary); }
.st-done { background: #dcfce7; color: #15803d; }
.st-off { background: var(--panel-2); color: var(--text-3); }
.ev-time { color: var(--text-3); font-size: 12px; }
.ev-summary { margin-top: 8px; font-size: 13px; color: var(--text-2); background: var(--panel-2); border-radius: 8px; padding: 8px 12px; }
.ev-info { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-top: 12px; font-size: 13px; color: var(--text-2); }
.who { display: inline-flex; align-items: center; gap: 6px; }
.ava { width: 22px; height: 22px; border-radius: 50%; color: #fff; font-size: 10px; display: inline-grid; place-items: center; background: var(--text-3); }
.manual-tag { font-size: 11px; padding: 1px 8px; border-radius: 999px; background: #ede9fe; color: #6d28d9; }
.sla { font-size: 12px; color: var(--text-3); }
.sla.over { color: #b45309; font-weight: 600; }
.escalated-tag { font-size: 11px; padding: 1px 8px; border-radius: 999px; background: #fef3c7; color: #b45309; font-weight: 600; }
.sync-tag { font-size: 11px; padding: 1px 8px; border-radius: 999px; }
.sync-tag.ok { background: #dcfce7; color: #15803d; }
.sync-tag.fail { background: #fef2f2; color: #b91c1c; font-weight: 600; }
.done-reason { font-size: 12px; color: var(--text-3); }
.err-box { margin-top: 10px; padding: 8px 12px; border-radius: 8px; background: #fef2f2; border: 1px solid #fecaca; color: #b91c1c; font-size: 12px; }
.linked-doc { margin-top: 12px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; cursor: pointer; }
.linked-doc.missing { color: var(--text-3); cursor: default; }
.lk-title { color: var(--primary); font-weight: 600; }
.lk-title:hover { text-decoration: underline; }
.linked-doc .go { margin-left: auto; color: var(--primary); font-size: 12px; }
.acts { margin-top: 12px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.acts-inline { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.assign-box { margin-top: 12px; border-top: 1px dashed var(--border); padding-top: 12px; display: flex; flex-direction: column; gap: 8px; }
.assign-box select { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px 10px; font-size: 13px; background: var(--panel); outline: none; max-width: 360px; }
.assign-box select:focus { border-color: var(--primary); }
.lk-hint { font-size: 12px; color: var(--text-3); }
.timeline { margin-top: 10px; }
.timeline summary { cursor: pointer; font-size: 12px; color: var(--text-3); }
.tl { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; padding: 4px 0; font-size: 12px; }
.tl-act { font-weight: 600; color: var(--primary); min-width: 150px; }
.tl-who { color: var(--text-2); min-width: 50px; }
.tl-note { color: var(--text-2); flex: 1; }
.tl-tm { color: var(--text-3); }
.empty { text-align: center; padding: 40px; color: var(--text-3); }
.empty .ico { font-size: 28px; margin-bottom: 8px; }
.foot-tip { margin-top: 14px; color: var(--text-3); font-size: 12px; text-align: center; }
</style>
