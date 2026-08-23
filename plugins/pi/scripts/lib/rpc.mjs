import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { budgetExceeded } from "./budget.mjs";
import { isTruncationReason } from "./finish-reason.mjs";
import { createInboxWatcher } from "./inbox.mjs";
import { attachJsonlReader, parseJsonLine } from "./jsonl.mjs";
import { runCommand } from "./process.mjs";
import {
  applyPiEvent,
  buildPiArgs,
  continuationPrompt,
  producedWork,
  thinkingLength,
  LOOP_NUDGE_PROMPT,
  MAX_LOOP_NUDGES,
  THINKING_BLOAT_CHARS,
  THINKING_BLOAT_HITS,
  THINKING_BLOAT_WINDOW,
  createTurnState,
  joinRecoveredText,
  PI_BINARY,
  redactArgs,
  recoveryDecision,
  summarizeTiming,
  truncationRetryLimit
} from "./pi.mjs";
import { MASKED_MODEL, MASKED_PROVIDER, startCredentialProxy } from "./credential-proxy.mjs";
import { openGitProxy, withGitProxy } from "./git-proxy.mjs";
import { settleProxyPorts } from "./proxy-bind.mjs";
import { awaitSandboxSlot, isSandboxed, removeSandboxContainer, resolveLaunch } from "./sandbox.mjs";

const SETTLE_GRACE_MS = 1500;
const SHUTDOWN_GRACE_MS = 5000;
/**
 * How long a continuation may go unanswered before the run stops waiting for it.
 *
 * Sending it takes away the finish detector; pi normally gives it back within
 * milliseconds by starting a turn, and refuses it loudly when it cannot. This
 * covers the third case — neither — which would otherwise hold the run until its
 * hard timeout, hours after there was anything left to wait for.
 */
const RECOVERY_ACK_TIMEOUT_MS = 60_000;

/**
 * Run one job against a live `pi --mode rpc` session.
 *
 * Unlike the one-shot json mode, the process stays up for the whole job, which
 * is what makes mid-flight steering possible: control messages appended to the
 * job inbox are forwarded as `steer` / `follow_up` / `abort` commands.
 */
/**
 * Bring up the credential proxy for a sandboxed run, if the provider allows it.
 *
 * Never fatal: a proxy that cannot start means the run proceeds the old way,
 * with the provider's own credential mounted, rather than not running at all.
 */
/** Provider the run really used, for records that must not show the mask. */
function proxyProviderOf(sandbox) {
  return sandbox?.provider ?? "unknown";
}

async function openCredentialProxy(sandbox, onProgress, model, jobId = null) {
  // `proxyCredentials: false` in a profile opts out — for a provider whose
  // endpoint does something the plain forwarder here does not reproduce.
  if (!isSandboxed(sandbox) || !sandbox.auth || !sandbox.provider || sandbox.proxyCredentials === false) {
    return null;
  }
  try {
    const homeDir = os.homedir();
    const auth = JSON.parse(fs.readFileSync(path.join(homeDir, ".pi", "agent", "auth.json"), "utf8"));
    const proxy = await startCredentialProxy({
      homeDir,
      provider: sandbox.provider,
      model,
      authEntry: auth?.[sandbox.provider],
      onWarning: (message) => onProgress?.({ phase: "working", message }),
      // Ties the per-request telemetry to the run; without it the proxy
      // measures nothing rather than writing rows nothing can be joined to.
      jobId
    });
    if (proxy) {
      onProgress?.({ phase: "starting", message: `Credentials stay on the host: ${sandbox.provider} goes through a run-scoped proxy.` });
    }
    if (!proxy) {
      // Falling back means the provider's own credential goes into the
      // container. That is a downgrade of the boundary and has to be audible,
      // not a silent difference between two runs that look identical.
      onProgress?.({
        phase: "starting",
        message: `Credential proxy unavailable for ${sandbox.provider}; mounting that provider's credential instead.`
      });
    }
    return proxy;
  } catch (error) {
    onProgress?.({
      phase: "starting",
      message: `Credential proxy could not start (${error instanceof Error ? error.message : String(error)}); falling back to mounting credentials.`
    });
    return null;
  }
}

/** Медиана без сортировки исходного массива — он ещё нужен в исходном порядке. */
function percentileOf(values, fraction) {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

export async function runPiRpcTurn({
  cwd,
  prompt,
  timeoutMs = 1_800_000,
  onProgress = null,
  onSpawn = null,
  eventsFile = null,
  inboxFile = null,
  settleGraceMs = SETTLE_GRACE_MS,
  recoveryAckMs = RECOVERY_ACK_TIMEOUT_MS,
  env = process.env,
  sandbox = null,
  jobId = null,
  budget = null,
  ...options
} = {}) {
  if (!prompt || !String(prompt).trim()) {
    throw new Error("Refusing to start pi with an empty prompt.");
  }
  const truncationRetries = truncationRetryLimit(env);

  // A profile may cap how many of its containers run at once, because the
  // provider behind it caps sessions. Queue here, before the container is
  // started, so the wait costs time instead of a failed run.
  // Credentials stay on the host: the container gets a token for a proxy that
  // lives exactly as long as this run. Falls back to the previous behaviour for
  // providers whose endpoint cannot be resolved.
  const proxy = await openCredentialProxy(sandbox, onProgress, options.model ?? null, jobId);
  if (proxy) {
    sandbox = {
      ...sandbox,
      credentialProxy: { url: proxy.url, token: proxy.token, providerEntry: proxy.providerEntry }
    };
    // pi is told to use the masked names; the proxy maps them back. Reported
    // usage still names the real model, which is what the journal records.
    options = { ...options, provider: MASKED_PROVIDER, model: MASKED_MODEL };
  }
  // Same bargain for forge credentials: the container gets a run token and a
  // loopback URL, and the token that can read the repositories stays here.
  const gitProxy = await openGitProxy(sandbox, onProgress);
  sandbox = withGitProxy(sandbox, gitProxy);
  // Both proxies bind loopback, and the hop that carries the container's
  // connections there needs a moment to notice them.
  // Registered the moment both exist, because everything between here and the
  // end of the run can throw: a queue that gives up waiting for a slot, a
  // container that fails to spawn, a budget that stops the turn. Any of those
  // used to leave the listener alive with a live forge token behind it.
  const closeProxies = async () => {
    // Read before close, reported to the run header: a push the agent tried is
    // otherwise invisible — it fails inside the container and the host only sees
    // a 403 count that goes nowhere. Same for a run token someone else probed.
    const git = gitProxy?.stats?.();
    if (git && (git.blocked || git.rejected)) {
      const parts = [];
      if (git.blocked) parts.push(`${git.blocked} push/dumb-http request(s) refused`);
      if (git.rejected) parts.push(`${git.rejected} request(s) with a wrong run token`);
      onProgress?.({ phase: "working", message: `Git proxy blocked ${parts.join(", ")}.` });
    }
    await proxy?.close();
    await gitProxy?.close();
  };
  await settleProxyPorts(proxy, gitProxy);
  const piArgs = buildPiArgs({ ...options, mode: "rpc" });
  // The body runs inside a closure so the proxies are closed on every exit
  // from here on, not only the one that reaches the end: a slot wait that
  // gives up, a container that fails to spawn and a rejected turn all used to
  // leave a listener alive with a live forge token behind it.
  const runTurn = async () => {
    const slot = await awaitSandboxSlot(sandbox, { timeoutMs, onProgress });
    const launch = resolveLaunch({ sandbox, binary: PI_BINARY, piArgs, cwd, jobId, env });
    const state = createTurnState();
    const report = (event) => {
      if (event && onProgress) {
        onProgress(event);
      }
    };

    report({ phase: "starting", message: `Running ${launch.command} ${redactArgs(launch.args)}` });

    const child = spawn(launch.command, launch.args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32"
    });
    onSpawn?.({ pid: child.pid ?? null, containerName: launch.containerName });
    // `spawn` returns before the docker client has even exec'd, so releasing here
    // would restore the very race the reservation exists for. The reservation
    // expires on its own; releasing it early is only an optimisation, and it can
    // wait until the container is actually visible.
    const releaseSlotWhenVisible = () => {
      if (!launch.containerName) {
        slot.release?.();
        return;
      }
      const deadline = Date.now() + 15_000;
      const poll = setInterval(() => {
        const visible = runCommand("docker", ["ps", "--filter", `name=${launch.containerName}`, "--format", "{{.Names}}"]);
        if (Date.now() >= deadline || String(visible.stdout ?? "").includes(launch.containerName)) {
          clearInterval(poll);
          slot.release?.();
        }
      }, 500);
      poll.unref?.();
    };
    releaseSlotWhenVisible();

    let stderr = "";
    let settledAt = null;
    let aborted = false;
    let budgetStop = null;
    let closing = false;
    let lastControlAt = 0;
    // Recovery after an answer cut off at the output ceiling. The failure is not
    // cosmetic: the truncated answer loses its tool call, so if that was the
    // last turn the agent stops mid-work and the run still exits successfully.
    // Everything needed to carry on is already here — this is the live channel
    // of that very session — so the run asks itself to continue instead of
    // ending and waiting for someone to notice.
    let lastStopReason = null;
    // The allowance counts CONSECUTIVE truncations: a run lives for hours and
    // hundreds of turns, and a truncation at its start, after which the agent
    // worked fine for an hour, says nothing about whether it is stuck now. The
    // counter resets on every answer carried to the end. The total is only
    // counted — for the message and the job row; what bounds the run is its
    // timeout and its budget.
    let consecutiveRecoveries = 0;
    let totalRecoveries = 0;
    // Ответ, разорванный потолком, собирается обратно в один.
    //
    // Прогон отдаёт как ответ ПОСЛЕДНЕЕ сообщение, и это верно ровно до тех
    // пор, пока последнее сообщение не оказывается продолжением: половина,
    // написанная до обрыва, тогда просто пропадает. Для прогона, чей
    // deliverable — сам текст (read-only исследователь, ревью), эта половина и
    // есть работа. `answerAnchor` — индекс первого куска серии, `answersSeen` и
    // `lastAnswerIndex` нужны, чтобы якорь не уехал на чужой ответ.
    let answerAnchor = null;
    let answersSeen = 0;
    let lastAnswerIndex = null;
    // Окно ходов, ушедших целиком в размышление: единица — такой ход, ноль — любой
    // другой. Считается скользящим окном, а не подряд идущей серией: у вырождения
    // раздутые ходы идут ЧЕРЕЗ ОДИН, перемежаясь короткими, и требование серии
    // подряд не поймало бы ни одного из проверенных случаев.
    const bloatWindow = [];
    // Сколько раз ниже был ОТПРАВЛЕН prompt-нудж в сессию — не сколько раз агент
    // его подхватил. `send()` подтверждает только запись в stdin живого процесса;
    // добрался ли текст до модели и изменил ли её поведение, protocol не говорит:
    // response на команду `prompt` подтверждает приём pi, а не то, что модель
    // прочла сообщение и поступила иначе. Надёжного признака подхвата в потоке
    // событий нет — следующий ход мог перестать буксовать и сам по себе, без
    // всякого вмешательства, — поэтому счётчик и не пытается его изображать.
    let loopNudges = 0;
    // Круг замечен, но сообщение ещё не отправлено: ход оборвался на потолке, и
    // отправлять надо на `agent_settled`, а не здесь. Причины две. Отправка
    // ВМЕСТО продолжения — на один обрыв уходит ровно одно сообщение: «продолжи
    // с места обрыва» и «не продолжай, прими решение» в одном ходе противоречат
    // друг другу, и модель отвечает на это словами «сообщения сбивают с толку».
    // И доставка: обрезанный ход pi отбрасывает целиком, steer-очередь этого
    // хода уходит в никуда вместе с ним, а `prompt` на settled-агенте открывает
    // новый ход.
    let nudgePending = false;
    // Нудж отправлен и ещё не подхвачен — сторож ровно того же смысла, что
    // `recoverySentAt` ниже: отправка гасит детектор завершения, и вернуть его
    // некому, если сообщение никуда не доехало.
    let nudgeSentAt = null;
    // Распределение рассуждения по ходам: одна суммарная цифра не отличает
    // «думал понемногу на каждом ходу» от «утонул на трёх», а лечится это разным.
    const thinkPerTurn = [];
    let turnsIdle = 0;
    const foldRecoveredAnswer = () => {
      if (answerAnchor === null) {
        return;
      }
      const pieces = state.assistantTexts.slice(answerAnchor).filter(Boolean);
      if (pieces.length > 1) {
        state.assistantTexts.splice(answerAnchor, pieces.length, pieces.reduce(joinRecoveredText));
      }
      answerAnchor = null;
      answersSeen = state.assistantTexts.length;
      lastAnswerIndex = state.assistantTexts.length ? state.assistantTexts.length - 1 : null;
    };

    // When a continuation was handed to pi and has not been picked up yet.
    // Sending it switches off the only "the run is over" detector (`settledAt`),
    // so something has to switch it back on if the continuation goes nowhere —
    // otherwise the run stands until the hard timeout, which on a three-hour
    // preset means three hours of nothing.
    let recoverySentAt = null;
    const delivered = [];

    const send = (command) => {
      if (child.stdin.destroyed || child.stdin.writableEnded) {
        return false;
      }
      child.stdin.write(`${JSON.stringify(command)}\n`);
      return true;
    };

    const appendEvent = (event) => {
      if (!eventsFile) {
        return;
      }
      try {
        // pi stamps a message with the time it was created, which makes
        // message_start and message_end carry the same value; the arrival time is
        // the only thing in the journal that can date an event afterwards.
        fs.appendFileSync(eventsFile, `${JSON.stringify({ ...event, receivedAt: Date.now() })}\n`, "utf8");
      } catch {
        // A broken transcript must never take the job down.
      }
    };

    attachJsonlReader(child.stdout, (line) => {
      const event = parseJsonLine(line);
      if (!event) {
        return;
      }

      if (event.type === "response") {
        if (event.command === "get_state" && event.data) {
          if (event.data.sessionId) {
            state.sessionId = String(event.data.sessionId);
          }
          // The effective thinking level, which is what pi resolved from flags,
          // settings and the model — not necessarily what the caller asked for.
          if (event.data.thinkingLevel) {
            state.thinkingLevel = String(event.data.thinkingLevel);
          }
        }
        if (event.success === false) {
          const detail = event.error ?? event.message ?? "unknown error";
          state.errors.push(`pi rejected "${event.command}": ${detail}`);
          report({ phase: "working", message: `pi rejected ${event.command}: ${detail}` });
          // A refused continuation must not leave the run waiting for a turn
          // that will never start: the agent has settled and stays settled, so
          // hand the finish detector back what sending the prompt took from it.
          //
          // Сверяется ИМЕННО id: отказов на команду `prompt` в прогоне два вида —
          // продолжение после обрыва и вмешательство в круг, — и они летят по
          // очереди. Без сверки отказ одного гасил бы сторож другого: отбитый
          // нудж объявлял бы агента settled, пока продолжение ещё в полёте, и
          // прогон закрывался бы посреди работы.
          // id в ответе не гарантирован протоколом (pi возвращает тот, что нёс
          // отказанный command). Отказ без id разбирается по-старому — сторож
          // возвращает тот, кто его снял; сверка нужна ровно там, где отправок
          // две и перепутать их можно.
          const refusedId = String(event.id ?? "");
          const refusedNudge = refusedId.startsWith("nudge-");
          if (event.command === "prompt" && !refusedNudge && recoverySentAt !== null) {
            recoverySentAt = null;
            settledAt = Date.now();
          }
          if (event.command === "prompt" && refusedNudge && nudgeSentAt !== null) {
            nudgeSentAt = null;
            // Продолжение в полёте само вернёт сторож, когда решится его судьба;
            // трогать `settledAt` за него отсюда нельзя.
            if (recoverySentAt === null) {
              settledAt = Date.now();
            }
          }
        }
        return;
      }

      appendEvent(event);

      if (event.type === "agent_settled" && nudgePending) {
        // Круг, замеченный на ходе, который оборвался на потолке: сообщение
        // уходит здесь и ЗАМЕНЯЕТ продолжение. Продолжать нечего — ход целиком
        // ушёл в размышление, работы в нём нет, и просьба «продолжи» вернула бы
        // модель в тот же круг ещё на один потолок вывода.
        settledAt = Date.now();
        nudgePending = false;
        if (send({ type: "prompt", message: LOOP_NUDGE_PROMPT, id: `nudge-${loopNudges + 1}` })) {
          loopNudges += 1;
          // Обрыв закрыт вмешательством: причина не должна достаться
          // следующему `agent_settled` и превратиться там в продолжение.
          lastStopReason = null;
          settledAt = null;
          nudgeSentAt = Date.now();
          // Половина, написанная до обрыва, всё равно склеивается с тем, что
          // придёт дальше: вмешательство не делает её ненаписанной.
          if (answerAnchor === null && lastAnswerIndex !== null) {
            answerAnchor = lastAnswerIndex;
          }
          report({
            phase: "working",
            message:
              `Ход целиком ушёл в размышление и оборвался на потолке вывода — похоже на круг. ` +
              `Вместо продолжения прошу принять решение или вернуть блокер ` +
              `(вмешательство ${loopNudges} из ${MAX_LOOP_NUDGES}).`
          });
        }
      } else if (event.type === "agent_settled") {
        settledAt = Date.now();
        // Bounded on purpose: a model stuck repeating itself hits the ceiling
        // every time, and each attempt costs a full ceiling of tokens. When the
        // attempts run out the run ends as truncated, which is what the job
        // phase and its warning icon are for.
        const decision = recoveryDecision({
          stopReason: lastStopReason,
          consecutive: consecutiveRecoveries,
          consecutiveLimit: truncationRetries,
          blocked: closing || aborted || Boolean(budgetStop)
        });
        if (decision === "reset") {
          // The agent carried an answer to the end — earlier truncations no
          // longer predict anything, and the next one gets the full allowance.
          consecutiveRecoveries = 0;
          foldRecoveredAnswer();
        } else if (decision === "recover") {
          // Counted and announced only once the continuation is actually on the
          // wire: a write that failed spends an attempt on nothing and puts a
          // line in the log for work that was never asked for.
          // Хвост берётся только из текста, пришедшего в ЭТОЙ серии: чужая
          // концовка предыдущего доведённого ответа увела бы модель обратно в
          // уже сделанную работу.
          const cutTail = lastAnswerIndex !== null ? state.assistantTexts[lastAnswerIndex] ?? "" : "";
          if (send({ type: "prompt", message: continuationPrompt(cutTail), id: `recover-${totalRecoveries + 1}` })) {
            consecutiveRecoveries += 1;
            totalRecoveries += 1;
            lastStopReason = null;
            settledAt = null;
            recoverySentAt = Date.now();
            if (answerAnchor === null && lastAnswerIndex !== null) {
              answerAnchor = lastAnswerIndex;
            }
            report({
              phase: "working",
              message:
                `Ответ обрезан на потолке вывода — работа не доведена. Продолжаю сессию ` +
                `(подряд идущая попытка ${consecutiveRecoveries} из ${truncationRetries}, всего за прогон: ${totalRecoveries}).`
            });
          }
        }
      } else if (event.type === "agent_start" || event.type === "turn_start") {
        settledAt = null;
        recoverySentAt = null;
        nudgeSentAt = null;
      }

      const update = applyPiEvent(state, event);
      // Читается ПОСЛЕ applyPiEvent: до него текст этого ответа ещё не в
      // состоянии, и якорь склейки указал бы на чужой, более ранний ответ.
      // Порядок обработчиков от этого не страдает — `agent_settled` приходит
      // отдельным событием, когда `message_end` уже разобран целиком.
      if (event.type === "message_end" && event.message?.role === "assistant") {
        lastStopReason = event.message.stopReason ?? null;
        const answered = state.assistantTexts.length;
        // Ответ без текста индекса не даёт: склеивать в нём нечего.
        lastAnswerIndex = answered > answersSeen ? answered - 1 : null;
        answersSeen = answered;

        // Ход, целиком ушедший в размышление, — единственный надёжный признак
        // круга: обычная задумчивость всё равно заканчивается словом или вызовом.
        // Считать надо ИМЕННО работу, а не текст: ход с одним вызовом инструмента
        // текста не несёт вовсе, и по тексту вся пофайловая работа выглядит
        // пустой — вмешательства уходили бы в исправно работающего агента.
        const worked = producedWork(event.message);
        const thought = thinkingLength(event.message);
        thinkPerTurn.push(thought);
        if (thought > 0 && !worked) {
          turnsIdle += 1;
        }
        bloatWindow.push(thought >= THINKING_BLOAT_CHARS && !worked ? 1 : 0);
        if (bloatWindow.length > THINKING_BLOAT_WINDOW) {
          bloatWindow.shift();
        }
        const bloated = bloatWindow.reduce((sum, mark) => sum + mark, 0);
        const nudgeOff = String(env?.PI_LOOP_NUDGE ?? "") === "0";
        if (
          !nudgeOff &&
          bloated >= THINKING_BLOAT_HITS &&
          loopNudges < MAX_LOOP_NUDGES &&
          !nudgePending &&
          !closing &&
          !aborted &&
          !budgetStop
        ) {
          // Окно обнуляется в обеих ветках: иначе те же ходы вызвали бы второе
          // вмешательство на следующем же шаге, ещё до того, как первое могло
          // подействовать.
          if (isTruncationReason(lastStopReason)) {
            // Ход оборвался на потолке — отправка ждёт `agent_settled`, где она
            // заменит собой продолжение (см. `nudgePending`).
            nudgePending = true;
            bloatWindow.length = 0;
          } else if (
            send({
              type: "prompt",
              message: LOOP_NUDGE_PROMPT,
              id: `nudge-${loopNudges + 1}`,
              // Ход кончился, но прогон идёт: агент СТРИМИТ, и голый `prompt` pi
              // отвергает — «Agent is already processing. Specify
              // streamingBehavior». Поле снимает отказ и ничего не меняет для
              // settled-агента: pi смотрит на него, только когда стримит.
              streamingBehavior: "steer"
            })
          ) {
            loopNudges += 1;
            bloatWindow.length = 0;
            report({
              phase: "working",
              message:
                `Агент ${THINKING_BLOAT_HITS} раза за последние ${THINKING_BLOAT_WINDOW} ходов ` +
                `потратил ход целиком на размышление — похоже на круг. Прошу принять решение или вернуть блокер ` +
                `(вмешательство ${loopNudges} из ${MAX_LOOP_NUDGES}).`
            });
          }
        }
      }
      // The accumulated usage rides along with every progress event, so a job
      // that is still running can report what it has spent so far — until now
      // the number only existed in this process and landed on disk at the end.
      report(update ? { ...update, usage: state.usage } : null);

      // Checked on the same numbers the caller sees, right after they change: the
      // ceiling can only be enforced once the message that crossed it is paid for,
      // so the earliest useful moment is here. `abort` is the same command
      // steering uses — pi wraps up the turn instead of being killed, which keeps
      // whatever the agent has already produced.
      if (!budgetStop && !aborted) {
        const exceeded = budgetExceeded(budget, { usage: state.usage, turns: state.turns });
        if (exceeded) {
          budgetStop = exceeded;
          send({ type: "abort" });
          report({ phase: "working", message: `Budget reached: ${exceeded}. Stopping pi.` });
        }
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    // A spawn failure is a normal outcome here, not an exception to propagate: it
    // resolves like any other bad exit so the job gets a terminal record. Left as
    // a rejection it became an unhandled one — the waiter below only attaches a
    // fulfilment handler — and the process died with the job stuck at "running".
    let spawnError = null;
    const closed = new Promise((resolve) => {
      child.on("error", (error) => {
        spawnError = error;
        resolve(1);
      });
      child.on("close", (code, signal) => resolve(code == null ? (signal ? 1 : 0) : code));
    });

    // Writing the prompt can fail after the fact if pi exits first (EPIPE on a
    // 200KB review diff, for instance). Without a handler that is an unhandled
    // 'error' event on the socket, which takes the whole process down.
    child.stdin.on("error", (error) => {
      if (!closing) {
        state.errors.push(`Could not write to pi: ${error.message}`);
      }
    });

    send({ type: "get_state", id: "state-1" });
    send({ type: "prompt", message: String(prompt), id: "prompt-1" });

    /**
     * A control message that arrives while pi is working is steering; one that
     * arrives in the settle window re-opens the run as a new prompt, which is
     * what "nudge the agent" means once it has already stopped.
     */
    const handleControl = (entry) => {
      lastControlAt = Date.now();

      if (entry.kind === "abort") {
        aborted = true;
        send({ type: "abort" });
        report({ phase: "working", message: "Abort requested; stopping pi." });
        delivered.push({ ...entry, deliveredAs: "abort" });
        return;
      }

      const isSettled = settledAt !== null;
      const command = isSettled
        ? { type: "prompt", message: entry.message, id: entry.id }
        : entry.kind === "follow_up"
          ? { type: "follow_up", message: entry.message }
          : { type: "steer", message: entry.message };

      if (send(command)) {
        settledAt = null;
        delivered.push({ ...entry, deliveredAs: command.type });
        report({
          phase: "working",
          message: `Delivered ${command.type}: ${entry.message.slice(0, 120)}`
        });
      }
    };

    const inbox = inboxFile ? createInboxWatcher(inboxFile, handleControl) : null;

    // Killing the `docker run` client leaves the container running, so a
    // sandboxed job has to be stopped on the docker side as well.
    const stop = () => {
      killTree(child);
      if (isSandboxed(sandbox)) {
        removeSandboxContainer(launch.containerName);
      }
    };

    let timedOut = false;
    const hardTimer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            stop();
          }, timeoutMs)
        : null;

    // Close the session once pi has settled and nothing new arrived in the
    // grace window; an abort short-circuits the wait.
    await new Promise((resolve) => {
      const poll = setInterval(() => {
        // A process that never started has nothing to settle: waiting for the
        // grace window would burn the whole timeout before reporting the failure.
        if (spawnError) {
          clearInterval(poll);
          resolve();
          return;
        }
        inbox?.drain();
        if (recoverySentAt !== null && Date.now() - recoverySentAt >= recoveryAckMs) {
          state.errors.push("pi never picked up the continuation sent after a truncated answer.");
          recoverySentAt = null;
          settledAt = Date.now();
        }
        if (nudgeSentAt !== null && Date.now() - nudgeSentAt >= recoveryAckMs) {
          state.errors.push("pi never picked up the message sent after a loop in the agent's thinking.");
          nudgeSentAt = null;
          settledAt = Date.now();
        }
        const quietFor = Date.now() - Math.max(settledAt ?? 0, lastControlAt);
        if (settledAt !== null && (aborted || budgetStop || quietFor >= settleGraceMs)) {
          clearInterval(poll);
          resolve();
        }
      }, 200);
      poll.unref?.();

      closed.then(() => {
        clearInterval(poll);
        resolve();
      });
    });

    closing = true;
    inbox?.stop();

    if (!child.killed) {
      try {
        child.stdin.end();
      } catch {
        // Already gone.
      }
    }

    const exitStatus = await Promise.race([
      closed,
      new Promise((resolve) =>
        setTimeout(() => {
          stop();
          resolve(closed);
        }, SHUTDOWN_GRACE_MS).unref?.()
      )
    ]).catch((error) => {
      throw error;
    });

    if (hardTimer) {
      clearTimeout(hardTimer);
    }


    // Попытки могли кончиться на обрезанном ответе — куски всё равно склеиваются:
    // недоведённая работа читается целиком или не читается вовсе.
    foldRecoveredAnswer();
    const text = state.assistantTexts.at(-1) ?? "";
    const errors = [...state.errors];
    if (spawnError) {
      errors.push(`Could not start ${launch.command}: ${spawnError.message}`);
    }
    if (timedOut) {
      errors.push(`pi exceeded the ${Math.round(timeoutMs / 1000)}s timeout and was terminated.`);
    }
    if (aborted) {
      errors.push("The run was aborted before pi finished.");
    }
    if (budgetStop) {
      errors.push(`Stopped by the run budget: ${budgetStop}.`);
    }
    if (!text && !errors.length) {
      errors.push("pi produced no assistant output.");
    }
    if (stderr.trim() && (errors.length || exitStatus !== 0)) {
      errors.push(stderr.trim());
    }

    return {
      text,
      sessionId: state.sessionId,
      usage: state.usage,
      stopReason: state.stopReason,
      // The agent was told a masked name, so its reported model is that mask.
      // Statistics are about what actually answered, and only the host knows it.
      model: proxy?.realModel ? `${proxyProviderOf(sandbox)}/${proxy.realModel}` : state.model,
      turns: state.turns,
      toolCalls: state.toolCalls,
      toolErrors: state.toolErrors,
      timing: summarizeTiming(state.timing),
      peakContext: state.peakContext ?? 0,
      thinkingChars: state.thinkingChars ?? 0,
      // Already measured by the slot queue and thrown away until now: the time
      // this run spent waiting for a container of its own pool, which is time no
      // model spent working.
      slotWaitMs: slot.waitedMs ?? 0,
      // Per-request telemetry the proxy collected, rolled up for the job row.
      proxyStats: proxy?.stats?.() ?? null,
      queue: state.queue,
      steering: delivered,
      // How many times the run had to continue itself past the output ceiling.
      // Without it a clean run and a run rescued seven times look identical in
      // the journal, and "a series of truncations means change the executor" is
      // a rule nobody can apply.
      recoveredTruncations: totalRecoveries,
      // Отправлено, не подхвачено — см. комментарий у объявления `loopNudges`.
      loopNudges,
      thinkP50Chars: percentileOf(thinkPerTurn, 0.5),
      thinkMaxChars: thinkPerTurn.length ? Math.max(...thinkPerTurn) : 0,
      turnsIdle,
      aborted,
      budgetStop,
      thinkingLevel: state.thinkingLevel ?? null,
      exitStatus: errors.length ? 1 : (exitStatus ?? 0),
      stderr: stderr.trim(),
      errors,
      timedOut,
      closing,
      containerName: launch.containerName,
      command: `${launch.command} ${redactArgs(launch.args)}`
    };
  };

  try {
    return await runTurn();
  } finally {
    await closeProxies();
  }
}

function killTree(child) {
  if (!child.pid) {
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}
