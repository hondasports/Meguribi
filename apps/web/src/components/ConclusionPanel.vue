<script setup lang="ts">
import { ref, watch } from "vue";
import type { ApprovalRecord } from "@meguribi/core";
import type { ConclusionView, TurnLink } from "../discussion-view.js";

const props = defineProps<{
  view: ConclusionView | null;
  approval: ApprovalRecord | null;
  canDecide: boolean;
  actionPending: "approve" | "reject" | null;
  actionError: string | null;
  actionNotice: string | null;
}>();

const emit = defineEmits<{
  approve: [];
  reject: [payload: { reason: string; redo: boolean }];
  openTurn: [turnId: string];
}>();

const confirming = ref<"approve" | "reject" | null>(null);
const rejectReason = ref("");
const redo = ref(true);

watch(
  () => props.canDecide,
  (canDecide) => {
    if (!canDecide) confirming.value = null;
  },
);

function openTurn(link: TurnLink): void {
  if (link.exists) emit("openTurn", link.id);
}

function confirmApprove(): void {
  emit("approve");
  confirming.value = null;
}

function confirmReject(): void {
  const reason = rejectReason.value.trim();
  if (reason.length === 0) return;
  emit("reject", { reason, redo: redo.value });
  confirming.value = null;
}
</script>

<template>
  <section class="conclusion-panel" aria-labelledby="conclusion-heading">
    <header class="discussion-section-heading">
      <div>
        <h2 id="conclusion-heading">結論</h2>
        <span v-if="view">終了: {{ view.endedByLabel }}</span>
      </div>
      <div v-if="canDecide" class="decision-actions">
        <button type="button" class="approve-button" @click="confirming = 'approve'">承認</button>
        <button type="button" class="reject-button" @click="confirming = 'reject'">
          却下・再議論
        </button>
      </div>
    </header>

    <p v-if="view === null" class="discussion-empty">結論はまだありません</p>
    <template v-else>
      <p class="conclusion-text">{{ view.conclusion }}</p>

      <div v-if="view.issues.length > 0" class="conclusion-block">
        <h3>論点と立場</h3>
        <article v-for="issue in view.issues" :key="issue.issue" class="issue-card">
          <h4>{{ issue.issue }}</h4>
          <ul>
            <li v-for="position in issue.positions" :key="`${issue.issue}-${position.participant}`">
              <b>{{ position.participant }}</b>
              <span>{{ position.stance }}</span>
              <span class="turn-links">
                <template v-for="link in position.turnLinks" :key="link.id">
                  <button v-if="link.exists" type="button" @click="openTurn(link)">
                    {{ link.id }}
                  </button>
                  <span v-else class="missing-turn">{{ link.id }}</span>
                </template>
              </span>
            </li>
          </ul>
          <p class="resolution">対応: {{ issue.resolution }}</p>
        </article>
      </div>

      <div v-if="view.rejected.length > 0" class="conclusion-block">
        <h3>不採用案</h3>
        <article v-for="option in view.rejected" :key="option.option" class="issue-card rejected">
          <h4>{{ option.option }}</h4>
          <p>{{ option.reason }}</p>
          <span class="turn-links">
            <template v-for="link in option.turnLinks" :key="link.id">
              <button v-if="link.exists" type="button" @click="openTurn(link)">
                {{ link.id }}
              </button>
              <span v-else class="missing-turn">{{ link.id }}</span>
            </template>
          </span>
        </article>
      </div>

      <div v-if="view.openQuestions.length > 0" class="conclusion-block">
        <h3>残った論点</h3>
        <ul class="open-questions">
          <li v-for="question in view.openQuestions" :key="question">{{ question }}</li>
        </ul>
      </div>
    </template>

    <p v-if="approval" class="approval-record">
      {{ approval.decision === "approved" ? "承認済み" : "却下済み" }} · {{ approval.approver }} ·
      {{ approval.at }}
    </p>
    <p v-else-if="view && !canDecide" class="discussion-empty">承認待ちではありません</p>

    <div v-if="confirming" class="confirm-box" role="alertdialog" aria-modal="false">
      <template v-if="confirming === 'approve'">
        <p>この結論を承認します。承認後は内容を変更できません。よろしいですか。</p>
        <div class="confirm-actions">
          <button type="button" @click="confirming = null">戻る</button>
          <button
            type="button"
            class="approve-button"
            :disabled="actionPending !== null"
            @click="confirmApprove"
          >
            {{ actionPending === "approve" ? "承認中…" : "承認する" }}
          </button>
        </div>
      </template>
      <template v-else>
        <p>却下理由を入力してください。必要なら結論を破棄して議論をやり直せます。</p>
        <label>
          却下理由
          <textarea v-model="rejectReason" rows="3" maxlength="2000"></textarea>
        </label>
        <label class="redo-check">
          <input v-model="redo" type="checkbox" />
          議論をやり直す
        </label>
        <div class="confirm-actions">
          <button type="button" @click="confirming = null">戻る</button>
          <button
            type="button"
            class="reject-button"
            :disabled="actionPending !== null || rejectReason.trim().length === 0"
            @click="confirmReject"
          >
            {{ actionPending === "reject" ? "却下中…" : "却下する" }}
          </button>
        </div>
      </template>
    </div>

    <p v-if="actionError" class="action-error">{{ actionError }}</p>
    <p v-if="actionNotice" class="action-notice">{{ actionNotice }}</p>
  </section>
</template>
