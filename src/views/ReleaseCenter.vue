<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useKbStore } from '@/stores/kb'
import { useAuthStore } from '@/stores/auth'
import { useReleaseStore } from '@/stores/release'
import DocPill from '@/components/common/DocPill.vue'
import { formatDate, formatFull } from '@/utils/format'
import {
  GATE, gateStatusLabel, gateStatusCls, gateTimelineLabel,
  impactTypeLabel, impactStatusLabel, impactCounts, IMPACT,
  CHECK_SEVERITY, canSignOffCheck, canRecheckGate
} from '@/utils/release'
import { diffVersionFields, fieldLabels } from '@/utils/version'

const router = useRouter()
const kb = useKbStore()
const auth = useAuthStore()
const releaseStore = useReleaseStore()

const tab = ref('todo') // todo | mine | all
const confirmNoteMap = ref({})
const decideNoteMap = ref({})
const rollbackNoteMap = ref({})
const waiverNoteMap = ref({})
const busyId = ref('')

const isAdmin = computed(() => auth.user?.role === 'admin')
const docById = computed(() => Object.fromEntries(kb.docs.map((d) => [d.id, d])))
const userById = computed(() => Object.fromEntries(auth.users.map((u) => [u.id, u])))
const userName = (id) => (id === 'system' ? '系统' : userById.value[id]?.name || id)

function roleCtxOf(g) {
  return {
    userId: auth.user?.id,
    role: auth.user?.role,
    isOwner: !!g && g.ownerId === auth.user?.id
  }
}
function canWaiver(g, c) {
  return canSignOffCheck(c, roleCtxOf(g))
}
function canRecheck(g) {
  return canRecheckGate(g, roleCtxOf(g))
}

// 待我处理：阻断态中可处置（重新评估/豁免）的门禁 + 待负责人确认 + 待管理员审批
const todoList = computed(() =>
  releaseStore.sorted.filter((g) => {
    if (g.status === GATE.PENDING_APPROVAL) return isAdmin.value
    if (g.status === GATE.PENDING_CONFIRM) return isAdmin.value || g.ownerId === auth.user?.id
    if (g.status === GATE.BLOCKED) return canRecheck(g) || (g.checks || []).some((c) => canWaiver(g, c))
    return false
  })
)
const mineList = computed(() => releaseStore.sorted.filter((g) => g.submittedBy === auth.user?.id))
const allList = computed(() => isAdmin.value ? releaseStore.sorted : releaseStore.sorted.filter((g) => g.submittedBy === auth.user?.id || g.ownerId === auth.user?.id))

const list = computed(() => {
  if (tab.value === 'todo') return todoList.value
  if (tab.value === 'mine') return mineList.value
  return allList.value
})

const counts = computed(() => ({
  todo: todoList.value.length,
  mine: mineList.value.length,
  all: allList.value.length
}))

function changedFields(g) {
  if (!g.candidateSnapshot || !g.publishedSnapshot) return []
  return diffVersionFields(g.publishedSnapshot, g.candidateSnapshot)
}

function checkIcon(key) {
  return { review: '📝', fresh: '🥬', gap: '📮', retire: '🗄️' }[key] || '•'
}
function checkActionHint(c) {
  if (c.key === 'review') return '管理员在评审通道处置完成后重新评估'
  if (c.key === 'fresh') return '完成保鲜复核，或由文档负责人/管理员豁免'
  if (c.key === 'gap') return '解决关联缺口工单，或由编辑者/管理员豁免'
  return '撤销退役/等待退役审批结案后重新评估'
}

async function recheck(g) {
  if (busyId.value) return
  busyId.value = g.id
  try {
    const res = await releaseStore.recheckGate(g.id, auth.user)
    if (res.status === 'ok') {
      if (res.cleared) alert('全部准入维度已通过，进入影响确认。')
      else alert('仍有阻断维度未消除。')
    } else alert('你没有重新评估资格或门禁状态已变化。')
  } finally {
    busyId.value = ''
  }
}

async function waiver(g, c) {
  const key = g.id + ':' + c.key
  const res = await releaseStore.signOffCheck(g.id, c.key, (waiverNoteMap.value[key] || '').trim(), auth.user)
  if (res.status === 'ok') {
    waiverNoteMap.value = { ...waiverNoteMap.value, [key]: '' }
  } else if (res.status === 'denied' || res.status === 'guest') {
    alert('你没有该维度的豁免权限。')
  } else alert('门禁状态已变化。')
}

async function confirmItem(g, key) {
  const res = await releaseStore.confirmImpact(g.id, key, auth.user)
  if (res.status === 'denied') alert('只有文档负责人或管理员可以确认影响。')
}

async function confirmAll(g) {
  if (g.impacts.some((it) => it.status === IMPACT.PENDING)) { alert('仍有影响项未逐项确认。'); return }
  const res = await releaseStore.confirmGate(g.id, (confirmNoteMap.value[g.id] || '').trim(), auth.user)
  if (res.status === 'ok') confirmNoteMap.value[g.id] = ''
  else if (res.status === 'denied') alert('只有文档负责人或管理员可以确认影响。')
}

async function withdraw(g) {
  if (!confirm('确定撤回该发布门禁？候选版本将不发布。')) return
  const res = await releaseStore.withdrawGate(g.id, auth.user)
  if (res.status !== 'ok') alert('操作失败：门禁状态已变化')
}

async function decide(g, decision) {
  if (busyId.value) return
  busyId.value = g.id
  try {
    const res = await releaseStore.decideGate(g.id, decision, (decideNoteMap.value[g.id] || '').trim(), auth.user)
    if (res.status === 'ok') decideNoteMap.value[g.id] = ''
    else if (res.status === 'denied' || res.status === 'guest') alert('只有管理员可以审批放行或驳回。')
    else if (res.status === 'blocked') alert('放行前复检发现新阻断，门禁已退回阻断态，请处置后再次送审。')
    else alert('操作失败：门禁状态已变化')
  } finally {
    busyId.value = ''
  }
}

async function rollback(g) {
  if (!confirm('确定回退 v' + g.version + '？问答引用与共享链接将恢复到 v' + g.publishedVersion + '。')) return
  const res = await releaseStore.rollbackGate(g.id, (rollbackNoteMap.value[g.id] || '').trim(), auth.user)
  if (res.status === 'ok') rollbackNoteMap.value[g.id] = ''
  else if (res.status === 'denied' || res.status === 'guest') alert('只有管理员可以回退版本。')
  else alert('操作失败：门禁状态已变化')
}

function impactIcon(type) {
  return { citation: '🤖', ticket: '📮', share: '🔗' }[type] || '•'
}

onMounted(async () => {
  await Promise.all([releaseStore.loadAll(), kb.loadAll()])
})
</script>

<template>
  <div class="gc-page">
    <header class="head">
      <h2>🚦 发布门禁</h2>
      <p class="sub">统一治理状态机：评审结论、知识保鲜、未解决缺口、退役关系四维度准入 → 跨角色处置/豁免 → 负责人确认影响 → 管理员审批放行或回退，阻断原因自动回写，重新发布时恢复历史确认状态。</p>
      <div class="tabs">
        <button :class="{ on: tab === 'todo' }" @click="tab = 'todo'">待我处理 <em>{{ counts.todo }}</em></button>
        <button :class="{ on: tab === 'mine' }" @click="tab = 'mine'">我提交的 <em>{{ counts.mine }}</em></button>
        <button :class="{ on: tab === 'all' }" @click="tab = 'all'">全部记录 <em>{{ counts.all }}</em></button>
      </div>
    </header>

    <div v-if="!list.length" class="empty card">
      <div class="ico">🚦</div>
      {{ tab === 'todo' ? '暂无待你处置阻断、确认或审批的发布门禁' : tab === 'mine' ? '你还没有提交过发布门禁' : '暂无发布门禁记录' }}
    </div>

    <div v-else class="gate-list">
      <div v-for="g in list" :key="g.id" class="gate card" :class="{ 'gate-blocked': g.status === GATE.BLOCKED }">
        <div class="g-top" @click="docById[g.docId] && router.push('/docs/' + g.docId)">
          <div class="g-main">
            <span class="g-doc-title">{{ docById[g.docId]?.title || g.docTitle || '已删除文档' }}</span>
            <DocPill v-if="docById[g.docId]" :doc="docById[g.docId]" />
          </div>
          <div class="g-side">
            <span class="st" :class="gateStatusCls(g.status)">{{ gateStatusLabel(g.status) }}</span>
            <span class="g-time">{{ formatDate(g.createdAt) }}</span>
          </div>
        </div>

        <div class="g-info">
          <span>{{ userName(g.submittedBy) }} 提交</span>
          <span class="g-ver">v{{ g.publishedVersion }} → v{{ g.version }}</span>
          <span v-if="changedFields(g).length" class="g-fields">变更：{{ fieldLabels(changedFields(g)).join('、') }}</span>
          <span v-if="g.confirmedAt" class="g-confirmed">负责人 {{ userName(g.confirmedBy) }} 已确认</span>
          <span v-if="g.decidedAt" class="g-decided">{{ userName(g.decidedBy) }} 于 {{ formatFull(g.decidedAt) }} {{ gateStatusLabel(g.status) }}</span>
        </div>
        <div v-if="g.note" class="g-note">变更说明：“{{ g.note }}”</div>
        <div v-if="g.decisionNote" class="g-note">审批意见：“{{ g.decisionNote }}”</div>
        <div v-if="g.rollbackNote" class="g-note">回退说明：“{{ g.rollbackNote }}”</div>

        <!-- 统一准入检查 -->
        <div v-if="g.checks && g.checks.length" class="checks">
          <div class="check" v-for="c in g.checks" :key="c.key" :class="c.status === 'blocked' ? (c.severity === CHECK_SEVERITY.HARD ? 'ck-hard' : 'ck-soft') : 'ck-pass'">
            <div class="ck-head">
              <span class="ck-ico">{{ checkIcon(c.key) }}</span>
              <span class="ck-label">{{ c.label }}</span>
              <span v-if="c.status === 'blocked'" class="ck-sev">{{ c.severity === CHECK_SEVERITY.HARD ? '须消除' : '可豁免' }}</span>
              <span class="ck-state">{{ c.status === 'pass' ? (c.waiver ? '已豁免' : '已通过') : '阻断中' }}</span>
            </div>
            <div v-if="c.status === 'blocked'" class="ck-body">
              <div v-for="b in c.blockers || []" :key="b.id" class="ck-reason">
                <b v-if="b.title">{{ b.title }}：</b>{{ b.reason }}
              </div>
              <div class="ck-hint">{{ checkActionHint(c) }}</div>
              <div v-if="canWaiver(g, c)" class="ck-act">
                <input :value="waiverNoteMap[g.id + ':' + c.key] || ''" placeholder="豁免说明（可选）" @input="waiverNoteMap[g.id + ':' + c.key] = $event.target.value" />
                <button class="btn xs waiver" :disabled="busyId === g.id" @click="waiver(g, c)">责任豁免</button>
              </div>
            </div>
            <div v-else-if="c.waiver" class="ck-waiver">
              {{ userName(c.waiver.by) }} 豁免<template v-if="c.waiver.note">：“{{ c.waiver.note }}”</template>
            </div>
          </div>
          <div v-if="g.status === GATE.BLOCKED" class="checks-acts">
            <button class="btn sm primary" :disabled="busyId === g.id || !canRecheck(g)" @click="recheck(g)">🔄 重新评估准入状态</button>
            <button v-if="g.submittedBy === auth.user?.id || isAdmin" class="btn sm ghost" @click="withdraw(g)">撤回门禁</button>
          </div>
        </div>

        <!-- 影响项（阻断态不展示逐项确认） -->
        <div v-if="g.status !== GATE.BLOCKED" class="impacts">
          <div class="imp-head">
            受影响关联（{{ impactCounts(g.impacts).total }}）：
            🤖 问答引用 {{ impactCounts(g.impacts).citation }} ·
            📮 缺口工单 {{ impactCounts(g.impacts).ticket }} ·
            🔗 共享链接 {{ impactCounts(g.impacts).share }}
            <span v-if="g.status === GATE.PENDING_CONFIRM" class="imp-progress">已确认 {{ impactCounts(g.impacts).confirmed }}/{{ impactCounts(g.impacts).total }}</span>
          </div>
          <div v-if="g.impacts?.some((it) => it.restoredFromGateId)" class="restore-hint">
            ♻️ {{ g.impacts.filter((it) => it.restoredFromGateId).length }} 项影响已沿用上轮门禁的确认结论
          </div>
          <div v-if="!g.impacts.length" class="imp-empty">无关联影响项</div>
          <div v-for="it in g.impacts" :key="it.key" class="impact" :class="'im-' + it.status">
            <span class="im-ico">{{ impactIcon(it.type) }}</span>
            <div class="im-body">
              <div class="im-title">{{ it.title }}</div>
              <div class="im-sub">
                <span class="im-type">{{ impactTypeLabel(it.type) }}</span>
                <span v-if="it.subtitle">{{ it.subtitle }}</span>
              </div>
            </div>
            <span class="im-state">{{ impactStatusLabel(it.status) }}</span>
            <button
              v-if="g.status === GATE.PENDING_CONFIRM && (isAdmin || g.ownerId === auth.user?.id) && it.status === IMPACT.PENDING"
              class="btn xs"
              @click="confirmItem(g, it.key)"
            >确认</button>
          </div>
        </div>

        <!-- 操作区 -->
        <div v-if="g.status === GATE.PENDING_CONFIRM && (isAdmin || g.ownerId === auth.user?.id)" class="acts">
          <textarea :value="confirmNoteMap[g.id] || ''" rows="2" placeholder="影响确认意见（可选）" @input="confirmNoteMap[g.id] = $event.target.value"></textarea>
          <div class="act-row">
            <button class="btn sm ok-solid" @click="confirmAll(g)">确认影响并提交审批</button>
            <button v-if="g.submittedBy === auth.user?.id || isAdmin" class="btn sm ghost" @click="withdraw(g)">撤回升版</button>
          </div>
        </div>

        <div v-if="g.status === GATE.PENDING_APPROVAL && isAdmin" class="acts">
          <textarea :value="decideNoteMap[g.id] || ''" rows="2" placeholder="审批意见（可选；放行前系统会再次复检四维度）" @input="decideNoteMap[g.id] = $event.target.value"></textarea>
          <div class="act-row">
            <button class="btn sm danger-ghost" :disabled="busyId === g.id" @click="decide(g, 'reject')">✕ 驳回（不发布）</button>
            <button class="btn sm ok-solid" :disabled="busyId === g.id" @click="decide(g, 'approve')">✓ 审批放行并发布</button>
          </div>
        </div>

        <div v-if="g.status === GATE.RELEASED && isAdmin" class="acts released-acts">
          <div class="released-hint">已放行：问答引用切换至 v{{ g.version }}，共享链接已同步新版内容。如发现问题可回退。</div>
          <div class="act-row">
            <input :value="rollbackNoteMap[g.id] || ''" placeholder="回退原因（可选）" @input="rollbackNoteMap[g.id] = $event.target.value" />
            <button class="btn sm danger-ghost" @click="rollback(g)">↩ 回退至 v{{ g.publishedVersion }}</button>
          </div>
        </div>

        <details class="timeline">
          <summary>查看留痕时间线（{{ (g.timeline || []).length }}）</summary>
          <div v-for="(t, i) in g.timeline || []" :key="i" class="tl">
            <span class="tl-act">{{ gateTimelineLabel(t.action) }}</span>
            <span class="tl-who">{{ userName(t.by) }}</span>
            <span v-if="t.note" class="tl-note">“{{ t.note }}”</span>
            <span class="tl-tm">{{ formatFull(t.at) }}</span>
          </div>
        </details>
      </div>
    </div>

    <p v-if="!isAdmin && tab === 'todo'" class="foot-tip">阻断态门禁可由提交人/负责人重新评估；保鲜维度负责人可豁免，缺口维度编辑者可豁免；审批放行由管理员完成。</p>
  </div>
</template>

<style scoped>
.gc-page { max-width: 920px; margin: 0 auto; }
.head h2 { margin: 0 0 4px; }
.sub { color: var(--text-2); font-size: 13px; margin: 0 0 14px; }
.tabs { display: flex; gap: 8px; }
.tabs button { border: 1px solid var(--border); background: var(--panel); padding: 7px 16px; border-radius: 999px; cursor: pointer; font-size: 13px; color: var(--text-2); }
.tabs button.on { background: var(--primary); border-color: var(--primary); color: #fff; font-weight: 600; }
.tabs em { font-style: normal; opacity: 0.7; margin-left: 2px; }
.gate-list { display: flex; flex-direction: column; gap: 12px; margin-top: 16px; }
.gate { padding: 16px 20px; }
.gate.gate-blocked { border-color: #fca5a5; }
.g-top { display: flex; justify-content: space-between; gap: 14px; cursor: pointer; }
.g-main { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.g-doc-title { font-weight: 700; font-size: 15px; }
.g-side { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; white-space: nowrap; }
.g-time { color: var(--text-3); font-size: 12px; }
.st { font-size: 12px; padding: 2px 10px; border-radius: 999px; }
.st-blocked { background: #fee2e2; color: #b91c1c; }
.st-confirm { background: #e0e7ff; color: #4338ca; }
.st-pending { background: #fef3c7; color: #b45309; }
.st-ok { background: #dcfce7; color: #15803d; }
.st-no { background: #fee2e2; color: #b91c1c; }
.st-off { background: var(--panel-2); color: var(--text-3); }
.st-rollback { background: #ffedd5; color: #c2410c; }
.g-info { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-top: 12px; font-size: 13px; color: var(--text-2); }
.g-ver { font-weight: 600; color: var(--primary); }
.g-fields { color: var(--text-3); font-size: 12px; }
.g-confirmed { color: #4338ca; font-size: 12px; }
.g-decided { color: var(--text-3); font-size: 12px; }
.g-note { margin-top: 8px; font-size: 13px; color: var(--text-2); background: var(--panel-2); border-radius: 8px; padding: 8px 12px; }

/* 准入检查 */
.checks { margin-top: 12px; border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; }
.check { border: 1px solid var(--border); border-radius: 8px; padding: 8px 12px; margin-bottom: 6px; background: var(--panel); }
.check.ck-pass { border-color: #86efac; background: #f0fdf4; }
.check.ck-soft { border-color: #fcd34d; background: #fffbeb; }
.check.ck-hard { border-color: #fca5a5; background: #fef2f2; }
.ck-head { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.ck-ico { font-size: 14px; }
.ck-label { font-weight: 600; }
.ck-sev { font-size: 11px; border-radius: 999px; padding: 0 8px; background: #fee2e2; color: #b91c1c; }
.ck-soft .ck-sev { background: #fef3c7; color: #b45309; }
.ck-state { margin-left: auto; font-size: 12px; color: #15803d; }
.ck-hard .ck-state, .ck-soft .ck-state { color: #b91c1c; font-weight: 600; }
.ck-body { margin-top: 4px; font-size: 12.5px; color: var(--text-2); }
.ck-reason { padding: 1px 0; }
.ck-hint { color: var(--text-3); font-size: 12px; }
.ck-act { display: flex; gap: 8px; margin-top: 6px; }
.ck-act input { flex: 1; border: 1px solid var(--border); border-radius: 6px; padding: 4px 10px; font-size: 12px; outline: none; }
.btn.xs.waiver { background: #f59e0b; border-color: #f59e0b; color: #fff; white-space: nowrap; }
.ck-waiver { margin-top: 4px; font-size: 12px; color: #b45309; }
.checks-acts { display: flex; gap: 8px; margin-top: 8px; }

.impacts { margin-top: 12px; border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; }
.imp-head { font-size: 12.5px; font-weight: 600; color: var(--text-2); margin-bottom: 8px; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.imp-progress { color: #4338ca; }
.restore-hint { font-size: 12px; color: #15803d; background: #f0fdf4; border-radius: 6px; padding: 4px 8px; margin-bottom: 6px; }
.imp-empty { font-size: 12.5px; color: var(--text-3); }
.impact { display: flex; gap: 10px; align-items: flex-start; padding: 7px 8px; border-radius: 8px; }
.impact.im-confirmed, .impact.im-released { background: #f0fdf4; }
.impact.im-reverted { opacity: 0.65; }
.im-ico { font-size: 14px; line-height: 1.5; }
.im-body { flex: 1; min-width: 0; }
.im-title { font-size: 13px; word-break: break-word; }
.im-sub { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 2px; font-size: 11.5px; color: var(--text-3); }
.im-type { background: var(--primary-weak); color: var(--primary); border-radius: 999px; padding: 0 8px; }
.im-state { font-size: 12px; color: #15803d; white-space: nowrap; }
.im-pending .im-state { color: #b45309; }
.im-reverted .im-state { color: var(--text-3); }
.btn.xs { padding: 2px 10px; font-size: 12px; }
.acts { margin-top: 12px; border-top: 1px dashed var(--border); padding-top: 12px; }
.acts textarea, .acts input { width: 100%; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px 10px; font-size: 13px; outline: none; }
.acts textarea { resize: vertical; }
.acts textarea:focus, .acts input:focus { border-color: var(--primary); }
.act-row { display: flex; gap: 8px; margin-top: 8px; }
.btn.ok-solid { background: #16a34a; border-color: #16a34a; color: #fff; }
.btn.ok-solid:hover { background: #15803d; color: #fff; }
.btn.danger-ghost { background: #fff; border-color: #f2555c; color: #b91c1c; }
.btn.danger-ghost:hover { background: #fef2f2; }
.released-hint { font-size: 12.5px; color: #15803d; margin-bottom: 8px; }
.timeline { margin-top: 10px; }
.timeline summary { cursor: pointer; font-size: 12px; color: var(--text-3); }
.tl { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; padding: 4px 0; font-size: 12px; }
.tl-act { font-weight: 600; color: var(--primary); min-width: 110px; }
.tl-who { color: var(--text-2); min-width: 50px; }
.tl-note { color: var(--text-2); flex: 1; }
.tl-tm { color: var(--text-3); }
.foot-tip { margin-top: 14px; color: var(--text-3); font-size: 12px; text-align: center; }
</style>
