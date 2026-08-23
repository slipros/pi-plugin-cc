#!/usr/bin/env python3
"""Стенд для RESEARCH-decoding-collapse.md.

Берёт префикс реальной сессии pi, переводит его в OpenAI-совместимый запрос и
шлёт провайдеру напрямую — мимо pi. Задача: понять, распадается ли декодирование
само по себе на длинном входе, или распад появляется только внутри обвязки.

Запуск:
  OLLAMA_API_KEY=... python3 scripts/bench-decoding-collapse.py \
      --session <путь к .jsonl> --cut 518 --model deepseek-v4-flash:0731 \
      --seed 1 --max-tokens 4096 --out результат.json
"""
import argparse
import json
import os
import sys
import time
import urllib.request

ENDPOINT = "https://ollama.com/v1/chat/completions"

BASH_TOOL = {
    "type": "function",
    "function": {
        "name": "bash",
        "description": "Run a shell command in the workspace and return its output.",
        "parameters": {
            "type": "object",
            "properties": {"command": {"type": "string", "description": "The command to run."}},
            "required": ["command"],
        },
    },
}


def load_messages(path, cut, resend_thinking=False):
    """Сообщения сессии pi до среза включительно, в формате OpenAI.

    `resend_thinking` повторяет то, что делает pi: каждый thinking-блок уходит
    обратно в поле, названное его же `thinkingSignature` (у этого провайдера —
    `reasoning`). Без этого история короче прод-запроса примерно на 30 тысяч
    токенов, то есть реплей проверяет не тот запрос, который сорвался.
    """
    out = []
    with open(path, encoding="utf8", errors="replace") as handle:
        raw = [json.loads(line) for line in handle if line.strip()]
    messages = [entry["message"] for entry in raw if entry.get("type") == "message"]
    for message in messages[:cut]:
        role = message.get("role")
        blocks = message.get("content") if isinstance(message.get("content"), list) else []
        if role == "user":
            out.append({"role": "user", "content": "".join(b.get("text", "") for b in blocks)})
        elif role == "assistant":
            text = "".join(b.get("text", "") for b in blocks if b.get("type") == "text")
            calls = [b for b in blocks if b.get("type") == "toolCall"]
            entry = {"role": "assistant", "content": text or None}
            thinking = [b for b in blocks if b.get("type") == "thinking" and (b.get("thinking") or "").strip()]
            if resend_thinking and thinking:
                signature = thinking[0].get("thinkingSignature") or "reasoning"
                entry[signature] = "\n".join(b["thinking"] for b in thinking)
            if calls:
                entry["tool_calls"] = [
                    {
                        "id": call.get("id"),
                        "type": "function",
                        "function": {
                            "name": call.get("name", "bash"),
                            "arguments": json.dumps(call.get("arguments") or {}, ensure_ascii=False),
                        },
                    }
                    for call in calls
                ]
            out.append(entry)
        elif role == "toolResult":
            out.append(
                {
                    "role": "tool",
                    "tool_call_id": message.get("toolCallId"),
                    "content": "".join(b.get("text", "") for b in blocks),
                }
            )
    return out


def repetition_run(text, window=20, threshold=10):
    """Самый длинный подряд идущий повтор одной подстроки.

    Признак распада берётся не по конкретным «wrath»/«wright»: мусорный токен у
    следующего срыва будет другим, а вот сама форма — одна подстрока, идущая
    подряд десятками раз — общая.
    """
    best = 0
    best_sub = ""
    for start in range(0, max(0, len(text) - window), window):
        chunk = text[start : start + window]
        if not chunk.strip():
            continue
        count = 1
        cursor = start + window
        while text[cursor : cursor + window] == chunk:
            count += 1
            cursor += window
        if count > best:
            best, best_sub = count, chunk
    return (best, best_sub) if best >= threshold else (best, "")


def stream_request(model, messages, seed, max_tokens, key, timeout=900, tools=(BASH_TOOL,)):
    body = {
        "model": model,
        "messages": messages,
        "tools": list(tools),
        "stream": True,
        "stream_options": {"include_usage": True},
    }
    if seed is not None:
        body["seed"] = seed
    if max_tokens:
        body["max_tokens"] = max_tokens

    request = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(body).encode("utf8"),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )

    started = time.time()
    text_parts = []
    reasoning_parts = []
    tool_calls = {}
    finish_reason = None
    usage = {}
    chunks = 0

    with urllib.request.urlopen(request, timeout=timeout) as response:
        for line in response:
            line = line.decode("utf8", errors="replace").strip()
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload == "[DONE]":
                break
            try:
                event = json.loads(payload)
            except json.JSONDecodeError:
                continue
            chunks += 1
            if event.get("usage"):
                usage = event["usage"]
            for choice in event.get("choices") or []:
                delta = choice.get("delta") or {}
                if delta.get("content"):
                    text_parts.append(delta["content"])
                # Провайдер шлёт канал рассуждения как `reasoning`; имя
                # `reasoning_content` встречается у других — читаем оба, иначе
                # канал, в котором происходит половина срывов, просто не виден.
                reasoning_delta = delta.get("reasoning") or delta.get("reasoning_content")
                if reasoning_delta:
                    reasoning_parts.append(reasoning_delta)
                for call in delta.get("tool_calls") or []:
                    index = call.get("index", 0)
                    slot = tool_calls.setdefault(index, {"name": "", "arguments": ""})
                    function = call.get("function") or {}
                    slot["name"] += function.get("name") or ""
                    slot["arguments"] += function.get("arguments") or ""
                if choice.get("finish_reason"):
                    finish_reason = choice["finish_reason"]

    text = "".join(text_parts)
    reasoning = "".join(reasoning_parts)
    repeats, sub = repetition_run(text)
    reasoning_repeats, reasoning_sub = repetition_run(reasoning)
    signatures = {}
    for slot in tool_calls.values():
        signatures[slot["arguments"][:200]] = signatures.get(slot["arguments"][:200], 0) + 1
    identical = max(signatures.values()) if signatures else 0

    return {
        "finish_reason": finish_reason,
        "elapsed_s": round(time.time() - started, 1),
        "chunks": chunks,
        "usage": usage,
        "text_chars": len(text),
        "reasoning_chars": len(reasoning),
        "tool_calls": len(tool_calls),
        "identical_tool_calls": identical,
        "repetition_run": repeats,
        "repetition_sample": sub[:60],
        "reasoning_repetition_run": reasoning_repeats,
        "reasoning_repetition_sample": reasoning_sub[:60],
        "think_tag_in_content": text.count("</think>"),
        "text_head": text[:200],
        "text_tail": text[-200:],
        "reasoning_tail": reasoning[-200:],
        # Режим A — распад декодирования: ответ упёрся в лимит И в нём мусорный
        # повтор либо десятки одинаковых вызовов. Одного признака мало: длинный
        # честный ответ тоже упирается в лимит.
        "collapsed_a": finish_reason == "length" and (repeats >= 10 or identical >= 5),
        # Режим B — кольцевое рассуждение: лимит выбран целиком, но наружу не
        # вышло ни вызова, ни ответа. Через повтор подстрок он не ловится —
        # текст там связный, кольцевой по смыслу, а не по буквам.
        "collapsed_b": finish_reason == "length" and not tool_calls and len(text.strip()) < 200,
        "collapsed": finish_reason == "length"
        and (repeats >= 10 or identical >= 5 or (not tool_calls and len(text.strip()) < 200)),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--session", required=True)
    parser.add_argument("--cut", type=int, required=True)
    parser.add_argument("--model", default="deepseek-v4-flash:0731")
    parser.add_argument("--seed", type=int, default=None)
    parser.add_argument("--max-tokens", type=int, default=4096)
    parser.add_argument("--system", default=os.path.expanduser("~/.claude/pi/prompts/developer.md"))
    parser.add_argument("--out", default=None)
    parser.add_argument("--label", default="")
    # Прод шлёт больше, чем история сессии: каталог инструментов и системный
    # промпт со скиллами собираются внутри pi. Эти два флага подставляют их,
    # чтобы стенд отличался от прода только тем, что мимо pi.
    parser.add_argument("--tools-file", default=None, help="JSON-массив описаний инструментов вместо одного bash")
    parser.add_argument("--system-extra", nargs="*", default=[], help="файлы, дописываемые к системному промпту")
    parser.add_argument("--resend-thinking", action="store_true", help="возвращать историю рассуждений, как это делает pi")
    args = parser.parse_args()

    key = os.environ.get("OLLAMA_API_KEY")
    if not key:
        sys.exit("OLLAMA_API_KEY не задан")

    messages = load_messages(args.session, args.cut, resend_thinking=args.resend_thinking)
    system = ""
    if os.path.exists(args.system):
        with open(args.system, encoding="utf8") as handle:
            system = handle.read()
    for path in args.system_extra:
        if os.path.exists(path):
            with open(path, encoding="utf8") as handle:
                system += "\n\n" + handle.read()
    if system:
        messages.insert(0, {"role": "system", "content": system})

    tools = [BASH_TOOL]
    if args.tools_file:
        with open(args.tools_file, encoding="utf8") as handle:
            tools = json.load(handle)

    result = stream_request(args.model, messages, args.seed, args.max_tokens, key, tools=tools)
    result.update(
        {
            "label": args.label,
            "model": args.model,
            "cut": args.cut,
            "seed": args.seed,
            "max_tokens": args.max_tokens,
            "messages": len(messages),
            "session": os.path.basename(args.session),
            "resend_thinking": args.resend_thinking,
        }
    )
    line = json.dumps(result, ensure_ascii=False)
    if args.out:
        with open(args.out, "a", encoding="utf8") as handle:
            handle.write(line + "\n")
    print(line)


if __name__ == "__main__":
    main()
