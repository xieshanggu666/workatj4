<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useKbStore } from '@/stores/kb'
import { useAuthStore } from '@/stores/auth'
import { useReviewStore } from '@/stores/review'
import { useCorrectionStore } from '@/stores/correction'
import DocPill from '@/components/common/DocPill.vue'
import { formatDate, formatFull, avatarColor } from '@/utils/format'
import {
  CORRECTION, correctionTypeLabel, correctionStatusLabel, correctionStatusCls,
  correctionTimelineLabel, canClaimCorrection, canReleaseCorrection, canSubmitCorrectionReview,
  canWithdrawCorrection, canReturnCorrection
} from '@/utils/correction'
import { canEditContent } from '@/utils/permission'
import { reviewStatusLabel } from '@/utils/review'

const route = useRoute()
const router = useRouter()
const kb = useKbStore()
const auth = useAuthStore()
const reviewStore = useReviewStore()
const correctionStore = useCorrectionStore()

const tab = ref('mine') // mine 我提交的（默认，提交人追踪状态）| open 待处理 | mine-edit 我修订的 | all 全部
const busyId = ref('')
const toast = ref('')
const returnNote = ref({}) // ticketId -> 退回说明输入
const returningId = ref('') // 正在填写退回说明的工单
const reviewNote = ref({}) // ticketId -> 送审说明

const TABS = [
  { key: 'mine', label: '我提交的' },
  { key: 'open', label: '待处理' },
  { key: 'mine-edit', label: '我修订的' },
  { key: 'all', label: '全部' }
]

const docById = computed(() => Object.fromEntries(kb.docs.map((d) => [d.id, d])))
const userById = computed(() => Object.fromEntries(auth.users.map((u) => [u.id, u])))
const canEdit = computed(() => canEditContent(auth.user?.role))
const uid = computed(() => auth.user?.id)

const sorted = computed(() =>
  [...correctionStore.tickets].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
)

const list = computed(() => {
  if (tab.value === 'mine') return sorted.value.filter((t) => t.createdBy === uid.value)
  if (tab.value === 'mine-edit') return sorted.value.filter((t) =>
    t.claimedBy === uid.value && (t.status === CORRECTION.CLAIMED || t.status === CORRECTION.IN_REVIEW))
  if (tab.value === 'open') return sorted.value.filter((t) => t.status === CORRECTION.SUBMITTED)
  return sorted.value
})

const counts = computed(() => ({
  mine: correctionStore.tickets.filter((t) => t.createdBy === uid.value).length,
  open: correctionStore.tickets.filter((t) => t.status === CORRECTION.SUBMITTED).length,
  'mine-edit': correctionStore.tickets.filter((t) =>
    t.claimedBy === uid.value && (t.status === CORRECTION.CLAIMED || t.status === CORRECTION.IN_REVIEW)).length,
  all: correctionStore.tickets.length
}))

const emptyText = computed(() => ({
  mine: '你还没有提交过纠错，可在文档详情页或问答引用处点击「报错」提交',
  open: '暂无待处理的纠错单',
  'mine-edit': '暂无你修订中的纠错单',
  all: '暂无纠错记录'
}[tab.value]))

// 可修订送审的文档：当前没有流转中评审单的文档（送审会锁定文档，需错开）
const linkableDocs = computed(() =>
  [...kb.docs]
    .filter((d) => !reviewStore.pendingReviewOf(d.id))
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
)

function reviewOf(t) {
  return t.reviewId ? reviewStore.reviews.find((r) => r.id === t.reviewId) : null
}

function showToast(msg) {
  toast.value = msg
  setTimeout(() => { toast.value = '' }, 3000)
}

async function claim(t) {
  if (busyId.value) return
  busyId.value = t.id
  try {
    const res = await correctionStore.claimTicket(t.id, auth.user)
    if (res.status !== 'ok') alert('认领失败：纠错单状态已变化，请刷新查看')
  } finally {
    busyId.value = ''
  }
}

async function release(t) {
  if (busyId.value) return
  if (!confirm('确定取消认领？纠错单将退回「待处理」。')) return
  busyId.value = t.id
  try {
    const res = await correctionStore.releaseTicket(t.id, auth.user)
    if (res.status !== 'ok') alert('取消认领失败：纠错单状态已变化，请刷新查看')
  } finally {
    busyId.value = ''
  }
}

// 修订人退回提交人补充信息
async function returnBack(t) {
  if (busyId.value) return
  const note = (returnNote.value[t.id] || '').trim()
  busyId.value = t.id
  try {
    const res = await correctionStore.returnTicket(t.id, note, auth.user)
    if (res.status === 'ok') {
      returningId.value = ''
      returnNote.value[t.id] = ''
      showToast('已退回提交人补充信息')
    } else {
      alert('退回失败：纠错单状态已变化，请刷新查看')
    }
  } finally {
    busyId.value = ''
  }
}

// 提交人/管理员撤回纠错单
async function withdraw(t) {
  if (busyId.value) return
  if (t.status === CORRECTION.IN_REVIEW) {
    if (!confirm('纠错单已送审，需要先撤回评审单。是否现在撤回评审（退回修订中）？')) return
    const res = await reviewStore.withdrawReview(t.reviewId, auth.user)
    if (res.status === 'ok') showToast('评审已撤回，纠错单退回修订中，可继续修订或撤单')
    else if (res.status === 'denied') alert('只有评审发起人可以撤回该评审单。')
    else alert('撤回失败：评审单状态已变化')
    return
  }
  if (!confirm('确定撤回该纠错单？撤回后不再进入处置流程（记录保留）。')) return
  busyId.value = t.id
  try {
    const res = await correctionStore.withdrawTicket(t.id, '', auth.user)
    if (res.status === 'ok') showToast('纠错单已撤回')
    else if (res.status === 'in-review') alert('纠错单送审中，请先撤回评审单。')
    else alert('撤回失败：纠错单状态已变化，请刷新查看')
  } finally {
    busyId.value = ''
  }
}

// 进入编辑器进行纠错修订（携带 correctionReview 参数，编辑器提交即关联送审）
function goRevise(t) {
  router.push({ path: '/docs/' + t.docId + '/edit', query: { correctionReview: t.id } })
}

// 不进入编辑器，直接以文档当前内容快速送审（修订已在其他途径完成的场景）
async function submitCurrent(t) {
  if (busyId.value) return
  const d = await kb.getDocFresh(t.docId)
  if (!d) { alert('文档不存在或已被删除'); return }
  busyId.value = t.id
  try {
    const res = await reviewStore.submitCorrectionReview(t.id, t.docId, {
      title: d.title, body: d.body, categoryId: d.categoryId,
      tagIds: d.tagIds || [], visibility: d.visibility
    }, (reviewNote.value[t.id] || '').trim() || ('纠错修订：' + t.description), auth.user)
    if (res.status === 'ok') {
      reviewNote.value[t.id] = ''
      showToast('已提交纠错修订送审，管理员审批通过后回写新版本并结案')
    } else if (res.status === 'duplicate') {
      alert('该文档已有流转中的评审单，请等待审批完成。')
    } else if (res.status === 'denied') {
      alert('你没有该文档的送审权限：仅文档拥有者、协作成员或管理员可发起评审。')
    } else {
      alert('送审失败：纠错单或文档状态已变化，请刷新后重试。')
    }
  } finally {
    busyId.value = ''
  }
}

onMounted(async () => {
  await Promise.all([correctionStore.loadAll(), reviewStore.loadAll()])
  if (route.query.submitted) showToast('纠错修订已送审，等待管理员审批')
})
</script>

<template>
  <div class="cor-page">
    <header class="head">
      <h2>🐞 知识纠错中心</h2>
      <p class="sub">成员在文档/问答中发现错误并<strong>关联文档提交</strong> → 编辑者认领并修订送审 → 管理员审批通过后<strong>回写新版本</strong>、问答引用自动指向修订内容；原提交人可在「我提交的」全程追踪，异常时可撤回，修订人可退回补充信息。</p>
      <div class="tabs">
        <button v-for="t in TABS" :key="t.key" :class="{ on: tab === t.key }" @click="tab = t.key">
          {{ t.label }} <em>{{ counts[t.key] }}</em>
        </button>
      </div>
    </header>

    <div v-if="toast" class="card toast-line">✅ {{ toast }}</div>

    <div v-if="!list.length" class="empty card">
      <div class="ico">🐞</div>
      {{ emptyText }}
    </div>

    <div v-else class="tk-list">
      <div v-for="t in list" :key="t.id" class="tk card">
        <div class="tk-top">
          <div class="tk-q">
            <span class="type-tag">{{ correctionTypeLabel(t.type) }}</span>
            <span class="desc">{{ t.description }}</span>
            <span v-if="t.source === 'qa'" class="src-tag" title="来自智能问答引用">🤖 问答引用</span>
          </div>
          <div class="tk-side">
            <span class="st" :class="correctionStatusCls(t.status)">{{ correctionStatusLabel(t.status) }}</span>
            <span class="tk-time">{{ formatDate(t.createdAt) }}</span>
          </div>
        </div>

        <div v-if="t.expected" class="tk-expected">期望：{{ t.expected }}</div>

        <div class="tk-info">
          <span class="who">
            <span class="ava" :style="{ background: avatarColor(t.createdBy) }">{{ userById[t.createdBy]?.avatar || '?' }}</span>
            {{ userById[t.createdBy]?.name || t.createdBy }} 提交
          </span>
          <span v-if="t.claimedBy" class="who">修订人：<b>{{ userById[t.claimedBy]?.name || t.claimedBy }}</b></span>
          <span v-if="t.resolvedAt" class="resolved-at">已于 {{ formatFull(t.resolvedAt) }} 解决</span>
        </div>

        <!-- 关联文档 -->
        <div v-if="t.docId && docById[t.docId]" class="linked-doc" @click="router.push('/docs/' + t.docId)">
          📄 关联文档：<span class="lk-title">《{{ docById[t.docId].title }}》</span>
          <DocPill :doc="docById[t.docId]" />
          <span class="go">查看 →</span>
        </div>
        <div v-else-if="t.docId" class="linked-doc missing">📄 关联文档已删除</div>

        <!-- 已解决：回填修订版本号 -->
        <div v-if="t.status === CORRECTION.RESOLVED" class="resolved-box">
          ✅ 修订已发布为新版本<template v-if="t.resolvedVersion"> <b>v{{ t.resolvedVersion }}</b></template>，问答引用已指向修订内容。
          <a v-if="t.docId && docById[t.docId]" @click.stop="router.push('/docs/' + t.docId)">查看修订后的文档 →</a>
        </div>

        <!-- 已撤回 -->
        <div v-else-if="t.status === CORRECTION.WITHDRAWN" class="withdrawn-box">
          ↩ 已由 {{ userById[t.withdrawnBy]?.name || t.withdrawnBy }} 于 {{ formatFull(t.withdrawnAt) }} 撤回
        </div>

        <!-- 操作区 -->
        <div v-if="t.status === CORRECTION.SUBMITTED" class="acts">
          <button v-if="canClaimCorrection(auth.user?.role, t)" class="btn sm primary" :disabled="busyId === t.id" @click="claim(t)">🙋 认领修订</button>
          <span v-else class="state-tip">等待编辑者认领修订…</span>
          <button v-if="canWithdrawCorrection(t, auth.user)" class="btn sm ghost" :disabled="busyId === t.id" @click="withdraw(t)">撤回纠错</button>
        </div>

        <template v-else-if="t.status === CORRECTION.CLAIMED">
          <!-- 修订人视角 -->
          <div v-if="canSubmitCorrectionReview(auth.user?.role, t, uid)" class="revise-box">
            <template v-if="returningId === t.id">
              <textarea v-model="returnNote[t.id]" rows="2" placeholder="说明需要提交人补充的信息（如错误位置、复现方式）…"></textarea>
              <div class="acts-inline">
                <button class="btn sm" :disabled="busyId === t.id" @click="returnBack(t)">确认退回</button>
                <button class="btn sm ghost" @click="returningId = ''">取消</button>
              </div>
            </template>
            <template v-else-if="t.docId">
              <div class="acts-inline">
                <button class="btn sm primary" @click="goRevise(t)">✎ 修订并送审</button>
                <button class="btn sm" :disabled="busyId === t.id" @click="submitCurrent(t)">以当前内容送审</button>
                <button class="btn sm ghost" :disabled="busyId === t.id" @click="release(t)">取消认领</button>
                <button class="btn sm ghost" @click="returningId = t.id">退回补充信息</button>
              </div>
              <div class="lk-hint">点击「修订并送审」进入编辑器修改内容，提交后文档锁定待管理员审批；审批通过即回写新版本、纠错单结案并通知提交人。</div>
            </template>
            <div v-else class="lk-hint warn">关联文档已被删除，无法继续修订送审。</div>
          </div>
          <!-- 其他成员视角 -->
          <div v-else class="acts">
            <span class="state-tip">🖊 {{ userById[t.claimedBy]?.name || t.claimedBy }} 修订中…</span>
            <button v-if="canWithdrawCorrection(t, auth.user)" class="btn sm ghost" :disabled="busyId === t.id" @click="withdraw(t)">撤回纠错</button>
          </div>
        </template>

        <div v-else-if="t.status === CORRECTION.IN_REVIEW" class="acts">
          <span class="state-tip">
            ⏳ 修订已送审，等待管理员审批<template v-if="reviewOf(t)">（评审单{{ reviewStatusLabel(reviewOf(t).status) }}）</template>。
            <a v-if="t.docId" @click="router.push('/docs/' + t.docId)">查看评审进度 →</a>
          </span>
          <button v-if="reviewOf(t)?.submittedBy === uid || auth.user?.role === 'admin'" class="btn sm ghost" :disabled="busyId === t.id" @click="withdraw(t)">撤回评审</button>
        </div>

        <details class="timeline">
          <summary>处理记录（{{ (t.timeline || []).length }}）</summary>
          <div v-for="(e, i) in t.timeline || []" :key="i" class="tl">
            <span class="tl-act">{{ correctionTimelineLabel(e.action) }}</span>
            <span class="tl-who">{{ e.by === 'system' ? '系统' : (userById[e.by]?.name || e.by) }}</span>
            <span v-if="e.note" class="tl-note">“{{ e.note }}”</span>
            <span class="tl-tm">{{ formatFull(e.at) }}</span>
          </div>
        </details>
      </div>
    </div>

    <p v-if="!canEdit" class="foot-tip">当前身份为只读成员：可提交与追踪纠错，认领、修订送审由编辑者/管理员完成。</p>
  </div>
</template>

<style scoped>
.cor-page { max-width: 900px; margin: 0 auto; padding-bottom: 40px; }
.head h2 { margin: 0 0 4px; }
.sub { color: var(--text-2); font-size: 13px; margin: 0 0 14px; }
.sub strong { color: var(--primary); }
.tabs { display: flex; gap: 8px; flex-wrap: wrap; }
.tabs button { border: 1px solid var(--border); background: var(--panel); padding: 7px 16px; border-radius: 999px; cursor: pointer; font-size: 13px; color: var(--text-2); }
.tabs button.on { background: var(--primary); border-color: var(--primary); color: #fff; font-weight: 600; }
.tabs em { font-style: normal; opacity: 0.7; margin-left: 2px; }
.toast-line { margin-top: 14px; padding: 10px 18px; font-size: 13px; color: #15803d; background: #f0fdf4; border-color: #16a34a; }
.tk-list { display: flex; flex-direction: column; gap: 12px; margin-top: 16px; }
.tk { padding: 16px 20px; }
.tk-top { display: flex; justify-content: space-between; gap: 14px; }
.tk-q { font-weight: 700; font-size: 15px; min-width: 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.desc { min-width: 0; }
.type-tag { font-size: 11px; font-weight: 600; padding: 2px 9px; border-radius: 999px; background: #fef2f2; color: #b91c1c; border: 1px solid #fecaca; white-space: nowrap; }
.src-tag { font-size: 11px; padding: 1px 8px; border-radius: 999px; background: var(--primary-weak); color: var(--primary); white-space: nowrap; }
.tk-side { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; white-space: nowrap; }
.st { font-size: 12px; padding: 2px 10px; border-radius: 999px; }
.st-submitted { background: #fef3c7; color: #b45309; }
.st-claimed { background: var(--primary-weak); color: var(--primary); }
.st-review { background: #e0f2fe; color: #0369a1; }
.st-resolved { background: #dcfce7; color: #15803d; }
.st-withdrawn { background: var(--panel-2); color: var(--text-3); }
.tk-time { color: var(--text-3); font-size: 12px; }
.tk-expected { margin-top: 8px; font-size: 13px; color: var(--text-2); background: var(--panel-2); border-radius: 8px; padding: 8px 12px; }
.tk-info { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-top: 12px; font-size: 13px; color: var(--text-2); }
.who { display: inline-flex; align-items: center; gap: 6px; }
.ava { width: 22px; height: 22px; border-radius: 50%; color: #fff; font-size: 10px; display: inline-grid; place-items: center; }
.resolved-at { font-size: 12px; color: var(--text-3); }
.linked-doc { margin-top: 12px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13px; cursor: pointer; }
.linked-doc.missing { color: var(--text-3); cursor: default; }
.lk-title { color: var(--primary); font-weight: 600; }
.lk-title:hover { text-decoration: underline; }
.linked-doc .go { margin-left: auto; color: var(--primary); font-size: 12px; }
.resolved-box { margin-top: 12px; padding: 10px 14px; border-radius: 8px; background: #f0fdf4; border: 1px solid #bbf7d0; color: #15803d; font-size: 13px; font-weight: 500; display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.resolved-box a { margin-left: auto; cursor: pointer; font-size: 12px; }
.withdrawn-box { margin-top: 12px; padding: 10px 14px; border-radius: 8px; background: var(--panel-2); color: var(--text-3); font-size: 13px; }
.acts { margin-top: 12px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.acts-inline { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.revise-box { margin-top: 12px; border-top: 1px dashed var(--border); padding-top: 12px; }
.revise-box textarea { width: 100%; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px 10px; font-size: 13px; resize: vertical; outline: none; margin-bottom: 8px; }
.revise-box textarea:focus { border-color: var(--primary); }
.lk-hint { margin-top: 8px; font-size: 12px; color: var(--text-3); }
.lk-hint.warn { color: #b45309; }
.state-tip { font-size: 13px; color: var(--text-2); }
.state-tip a { cursor: pointer; }
.timeline { margin-top: 10px; }
.timeline summary { cursor: pointer; font-size: 12px; color: var(--text-3); }
.tl { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; padding: 4px 0; font-size: 12px; }
.tl-act { font-weight: 600; color: var(--primary); min-width: 160px; }
.tl-who { color: var(--text-2); min-width: 50px; }
.tl-note { color: var(--text-2); flex: 1; }
.tl-tm { color: var(--text-3); }
.foot-tip { margin-top: 14px; color: var(--text-3); font-size: 12px; text-align: center; }
</style>
