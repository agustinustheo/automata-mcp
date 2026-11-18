<script setup lang="ts">
import { CheckIcon, MailIcon } from '@lucide/vue'
import { assertNever } from '#shared/connection'

/**
 * First-run setup, for the admin whose signup created the organization and no
 * one else (`onboarding` on the session; server/utils/onboarding.ts decides).
 * The middleware sends them here from the landing routes until they finish or
 * skip it.
 *
 *   1. pick a connector        ConnectionCreateForm's picker
 *   2. name + credentials      its form for the chosen kind
 *   3. scan (WhatsApp/Telegram) the kind's panel in `setup` mode
 *   4. first connector token   McpTokens, its create dialog opened from here
 *   5. update mail             self-hosted only: breaking changes and
 *                              security advisories, nothing else
 *
 * Every step is the ordinary route with its ordinary checks; this page only
 * orders them. Progress after the connection exists lives in the URL
 * (`?connection=&step=`), so a reload resumes where it was rather than creating
 * a second connection.
 */
type Step = 'pick' | 'details' | 'pair' | 'token' | 'updates'

const route = useRoute()
const { user, onboarding, refresh: refreshSession } = useSession()

const connectionId = computed(() => typeof route.query.connection === 'string' ? route.query.connection : undefined)
const kind = ref<InstanceKind | undefined>()

// Keyed on the id, so the step that adds `?connection=` fetches it, and no id
// asks nothing (a `useFetch` that starts not-immediate never wakes up).
// useRequestFetch carries the session cookie during SSR; bare $fetch would not.
const requestFetch = useRequestFetch()
const { data: summary, error: summaryError } = await useAsyncData(
  () => `welcome-summary-${connectionId.value ?? 'none'}`,
  () => connectionId.value
    ? requestFetch<{ instance: PublicInstanceRow, canManage: boolean }>(`/api/instances/${connectionId.value}/summary`)
    : Promise.resolve(null),
)
// A connection gone since (the unpaired reaper, or deleted elsewhere) restarts
// setup at the picker rather than showing an error.
handlesErrorItself(summaryError)
const connectionKind = computed(() => summaryError.value ? undefined : summary.value?.instance.kind)

/** Whether a kind is linked by scanning a code on a phone. */
function pairs(k: InstanceKind): boolean {
  switch (k) {
    case 'whatsapp':
    case 'telegram':
      return true
    case 'postgres':
    case 'imap':
      return false
    default:
      return assertNever(k, 'connection kind')
  }
}

const offersUpdates = computed(() => onboarding.value?.updates === true)

const step = computed<Step>(() => {
  const k = connectionKind.value
  if (!connectionId.value || !k) return kind.value ? 'details' : 'pick'
  const asked = route.query.step
  if (asked === 'updates' && offersUpdates.value) return 'updates'
  if (asked === 'token') return 'token'
  return pairs(k) ? 'pair' : 'token'
})

/** The steps this run has, in order: no scan for a database or mailbox, no updates on the hosted service. */
const steps = computed(() => {
  const k = connectionKind.value ?? kind.value
  return [
    { id: 'pick' as const, title: 'Pick a connector' },
    { id: 'details' as const, title: 'Name and credentials' },
    ...(!k || pairs(k) ? [{ id: 'pair' as const, title: 'Scan the QR code' }] : []),
    { id: 'token' as const, title: 'Create a token' },
    ...(offersUpdates.value ? [{ id: 'updates' as const, title: 'Stay informed' }] : []),
  ]
})
const currentIndex = computed(() => steps.value.findIndex(s => s.id === step.value))

function goTo(next: Step) {
  return navigateTo({ query: { connection: connectionId.value, step: next } })
}

async function created(instance: { id: string, kind: InstanceKind }) {
  await navigateTo({ query: { connection: instance.id, step: pairs(instance.kind) ? 'pair' : 'token' } })
}

// ── step 3 ────────────────────────────────────────────────────────────────
const paired = ref(false)

// ── step 4 ────────────────────────────────────────────────────────────────
const tokens = ref<{ openCreate: () => void } | null>(null)
const tokenCreated = ref(false)

function afterToken() {
  if (offersUpdates.value) return goTo('updates')
  return finish()
}

// ── step 5 ────────────────────────────────────────────────────────────────
const email = ref(user.value?.email ?? '')
const subscribed = ref(false)
const { busy: subscribing, run: runSubscribe } = useApiAction()

async function subscribe() {
  const ok = await runSubscribe(
    () => $fetch<{ ok: boolean }>('/api/onboarding/updates', { method: 'POST', body: { email: email.value.trim() } }),
    { failure: 'Could not sign you up' },
  )
  if (ok) subscribed.value = true
}

// ── finishing ─────────────────────────────────────────────────────────────
const { busy: finishing, run: runFinish } = useApiAction()

/** Finish or skip: either way setup is over, and the connection's page (or the list) is next. */
async function finish() {
  const done = await runFinish(
    async () => {
      await $fetch('/api/onboarding/finish', { method: 'POST' })
      await refreshSession()
      return true
    },
    { failure: 'Could not finish setup' },
  )
  if (!done) return
  await navigateTo(connectionKind.value && connectionId.value ? `/instances/${connectionId.value}` : '/instances/new')
}
</script>

<template>
  <div class="mx-auto space-y-8" :class="step === 'pick' || step === 'token' ? 'max-w-5xl' : 'max-w-xl'">
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 class="font-heading text-2xl font-semibold">
          Welcome to Automata
        </h1>
        <p class="mt-1 text-sm text-muted-foreground">
          A few steps to give Claude its first connection.
        </p>
      </div>
      <Button variant="ghost" size="sm" :disabled="finishing" @click="finish">
        Skip setup
      </Button>
    </div>

    <!-- ── progress ──────────────────────────────────────────────────────── -->
    <ol class="flex flex-wrap gap-x-6 gap-y-2 text-sm">
      <li
        v-for="(s, index) in steps"
        :key="s.id"
        class="flex items-center gap-2"
        :class="index === currentIndex ? 'font-medium' : 'text-muted-foreground'"
        :aria-current="index === currentIndex ? 'step' : undefined"
      >
        <span
          class="flex size-6 shrink-0 items-center justify-center rounded-full border text-xs"
          :class="index < currentIndex ? 'border-primary bg-primary text-primary-foreground' : index === currentIndex ? 'border-primary' : ''"
        >
          <CheckIcon v-if="index < currentIndex" class="size-3.5" />
          <template v-else>{{ index + 1 }}</template>
        </span>
        {{ s.title }}
      </li>
    </ol>

    <!-- ── 1–2: pick, then name and credentials ──────────────────────────── -->
    <section v-if="step === 'pick' || step === 'details'" class="space-y-4">
      <div>
        <h2 class="font-heading text-lg font-semibold">
          {{ step === 'pick' ? 'What should Claude connect to?' : 'Name it and add its credentials' }}
        </h2>
        <p class="mt-1 text-sm text-muted-foreground">
          {{ step === 'pick'
            ? 'Start with one. You can add more connections later, each with its own connector.'
            : 'Credentials are checked before anything is saved.' }}
        </p>
      </div>
      <ConnectionCreateForm v-model:kind="kind" @created="created" />
    </section>

    <!-- ── 3: scan ───────────────────────────────────────────────────────── -->
    <section v-else-if="step === 'pair' && connectionId" class="space-y-4">
      <div>
        <h2 class="font-heading text-lg font-semibold">
          Link your {{ connectionKind === 'telegram' ? 'Telegram account' : 'phone' }}
        </h2>
        <p class="mt-1 text-sm text-muted-foreground">
          Scan the code with {{ connectionKind === 'telegram' ? 'Telegram' : 'WhatsApp' }} on your phone.
          This page moves on once it is linked.
        </p>
      </div>

      <InstanceWhatsapp
        v-if="connectionKind === 'whatsapp'"
        :id="connectionId"
        can-manage
        setup
        @paired="paired = true"
      />
      <InstanceTelegram
        v-else-if="connectionKind === 'telegram'"
        :id="connectionId"
        can-manage
        setup
        @paired="paired = true"
      />

      <div class="flex justify-end">
        <Button :disabled="!paired" @click="goTo('token')">
          Continue
        </Button>
      </div>
    </section>

    <!-- ── 4: first token ────────────────────────────────────────────────── -->
    <section v-else-if="step === 'token' && connectionId && connectionKind" class="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Create your first connector token</CardTitle>
          <CardDescription>
            A token is what Claude signs in with. It reaches this connection and no
            other, you choose what it may do, and you can revoke it at any time.
            Once it is created, the next screen shows how to add it to Claude.
          </CardDescription>
        </CardHeader>
        <CardContent class="flex flex-wrap gap-3">
          <Button v-if="!tokenCreated" @click="tokens?.openCreate()">
            Create token
          </Button>
          <Button v-else :disabled="finishing" @click="afterToken">
            {{ offersUpdates ? 'Continue' : 'Finish setup' }}
          </Button>
          <Button v-if="!tokenCreated" variant="ghost" :disabled="finishing" @click="afterToken">
            Skip for now
          </Button>
        </CardContent>
      </Card>

      <McpTokens
        ref="tokens"
        :instance-id="connectionId"
        :kind="connectionKind"
        :connected="true"
        can-manage
        @created="tokenCreated = true"
      />
    </section>

    <!-- ── 5: update mail (self-hosted only) ─────────────────────────────── -->
    <section v-else-if="step === 'updates'" class="space-y-4">
      <Card>
        <CardHeader>
          <div class="flex items-center gap-2">
            <MailIcon class="size-5 text-muted-foreground" />
            <CardTitle>Hear about breaking changes and security fixes</CardTitle>
          </div>
          <CardDescription>
            You run this install yourself, so nobody can tell you when an update
            needs your attention. Leave an address and we will email it when a
            release has breaking changes or fixes a security issue.
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-4">
          <ul class="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>Only breaking changes and security advisories. A handful of emails a year.</li>
            <li>No marketing, no newsletters, no spam — and your address is never shared or sold.</li>
            <li>Every email has an unsubscribe link.</li>
          </ul>

          <template v-if="!subscribed">
            <div class="space-y-2">
              <Label for="updates-email">Email</Label>
              <Input
                id="updates-email"
                v-model="email"
                type="email"
                autocomplete="email"
                @keydown.enter="subscribe"
              />
              <p class="text-xs text-muted-foreground">
                Sent to Automata (getautomata.app) with this install's version,
                and used for these emails only.
              </p>
            </div>
            <div class="flex flex-wrap gap-3">
              <Button :disabled="subscribing || !email.trim()" @click="subscribe">
                {{ subscribing ? 'Signing up…' : 'Sign me up' }}
              </Button>
              <Button variant="ghost" :disabled="finishing" @click="finish">
                No thanks
              </Button>
            </div>
          </template>

          <template v-else>
            <p class="flex items-center gap-2 text-sm">
              <CheckIcon class="size-4 text-primary" />
              You're on the list.
            </p>
            <Button :disabled="finishing" @click="finish">
              Finish setup
            </Button>
          </template>
        </CardContent>
      </Card>
    </section>
  </div>
</template>
