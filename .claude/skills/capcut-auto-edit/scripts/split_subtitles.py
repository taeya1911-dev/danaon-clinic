#!/usr/bin/env python3
"""한국어 자막을 문맥 경계에서 나눈다.

글자 수만 세서 자르면 조사·어미가 다음 줄로 넘어가 읽기 불편해진다.
문장 끝 > 절 경계 > 어절 경계 순으로 나누고, 어쩔 수 없을 때만 강제로 자른다.
규칙 설명은 references/subtitle-rules.md 참고.

입출력은 [{"start": 초, "end": 초, "text": "..."}] 형식의 JSON.

  python split_subtitles.py < transcript.json > subtitles.json
  python split_subtitles.py --max-chars 12 --max-lines 2 < in.json > out.json
  python split_subtitles.py --self-test
"""

import argparse
import json
import math
import re
import sys

# 2순위 경계. 접속 표현은 다음 줄 첫머리로 보낸다 — 앞줄 끝에 남기면 문장이 끊긴 느낌이 든다.
CONNECTIVES = [
    "그리고", "그런데", "근데", "하지만", "그러나", "그래서", "따라서",
    "왜냐하면", "또한", "다만", "즉", "예를 들어", "그러면", "그럼", "그래도",
]

# 강제 분할 시 이것들로 시작하는 조각이 남으면 안 된다 ("한의원" / "에서는" 방지).
PARTICLES = [
    "습니다", "입니다", "합니다", "했습니다", "이다", "한다", "했다",
    "에서는", "에게는", "으로는", "까지", "부터", "보다", "처럼", "에서", "에게",
    "으로", "하고", "이나", "라도", "만큼", "라고",
    "은", "는", "이", "가", "을", "를", "에", "로", "와", "과", "의", "도", "만",
]

GAP_SEC = 0.08  # 자막 사이 최소 간격. 붙어 있으면 전환이 안 보인다.

SENT_END = re.compile(r"(?<=[.!?。？！])\s*")
COMMA = re.compile(r"(?<=[,،、])\s*")


def _boundaries_sentence(text):
    return [m.end() for m in SENT_END.finditer(text)]


def _boundaries_clause(text):
    pos = set(m.end() for m in COMMA.finditer(text))
    for word in CONNECTIVES:
        for m in re.finditer(r"(?:(?<=\s)|(?<=^))" + re.escape(word) + r"(?=\s|$)", text):
            pos.add(m.start())  # 접속어 앞에서 끊어 접속어를 다음 조각으로
    return sorted(pos)


def _boundaries_word(text):
    return [m.end() for m in re.finditer(r"\s+", text)]


def _pick(boundaries, text, capacity):
    """capacity 안에 드는 경계 중 조각 길이가 고르게 나뉘는 곳.

    무작정 꽉 채우면 마지막에 "봅니다" 같은 한 어절짜리 자투리 자막이 남는다.
    0.3초 스쳐 지나가는 자막이 생기는 게 정확히 이 때문이라, 조각 수를 먼저 정하고
    그 수로 균등하게 나눌 수 있는 경계를 고른다.
    """
    usable = [b for b in boundaries if 0 < b < len(text) and len(text[:b].rstrip()) <= capacity]
    if not usable:
        return None
    pieces = max(1, math.ceil(len(text) / capacity))
    target = len(text) / pieces
    return min(usable, key=lambda b: (abs(len(text[:b].rstrip()) - target), -b))


def _forced_cut(text, capacity):
    """한 어절이 capacity보다 길 때의 최후 수단. 조사만 다음 줄로 넘기지 않는다."""
    pos = min(capacity, len(text) - 1)
    for p in range(pos, max(1, pos - 6), -1):
        if not any(text[p:].startswith(j) for j in PARTICLES):
            return p
    return max(1, pos)


def split_text(text, capacity):
    """자막 한 장에 들어갈 조각들로 나눈다. capacity는 한 장의 최대 글자 수."""
    text = text.strip()
    if not text:
        return []
    if len(text) <= capacity:
        return [text]
    for finder in (_boundaries_sentence, _boundaries_clause, _boundaries_word):
        pos = _pick(finder(text), text, capacity)
        if pos is not None:
            head, tail = text[:pos].strip(), text[pos:].strip()
            if head and tail:
                return split_text(head, capacity) + split_text(tail, capacity)
    pos = _forced_cut(text, capacity)
    return split_text(text[:pos], capacity) + split_text(text[pos:], capacity)


def wrap_lines(text, max_chars, max_lines):
    """자막 한 장을 줄로 나눈다. 2줄이면 위아래 길이를 비슷하게 맞춘다."""
    if len(text) <= max_chars or max_lines < 2:
        return text
    words = text.split()
    best, best_score = None, None
    for i in range(1, len(words)):
        a, b = " ".join(words[:i]), " ".join(words[i:])
        if len(a) > max_chars or len(b) > max_chars:
            continue
        score = abs(len(a) - len(b))
        if best_score is None or score < best_score:
            best, best_score = (a, b), score
    if best:
        return "\n".join(best)
    return text  # 어떻게 나눠도 안 맞으면 그대로 두고 호출부가 capacity를 줄이게 한다


def split_cues(cues, max_chars=20, max_lines=2, min_duration=1.0, max_cps=9.0):
    capacity = max_chars * max_lines
    out = []
    for cue in cues:
        start, end = float(cue["start"]), float(cue["end"])
        pieces = split_text(str(cue.get("text", "")), capacity)
        if not pieces:
            continue
        total = sum(len(p) for p in pieces) or 1
        # 원래 발화 구간 안에서 글자 수에 비례해 시간을 나눈다.
        # 발화 밖으로 나가면 자막이 말보다 먼저 뜨거나 늦게 사라진다.
        cursor = start
        for i, piece in enumerate(pieces):
            share = (end - start) * len(piece) / total
            piece_end = end if i == len(pieces) - 1 else cursor + share
            out.append({
                "start": round(cursor, 3),
                "end": round(piece_end, 3),
                "text": wrap_lines(piece, max_chars, max_lines),
                "source_start": start,
                "source_end": end,
            })
            cursor = piece_end

    # 너무 짧아 못 읽는 자막은 뒤로 늘린다.
    # 말이 끝난 뒤 잠깐 더 떠 있는 건 자연스럽지만, 다음 자막 시작을 침범하면
    # 두 자막이 겹쳐 보이므로 거기까지만 늘린다.
    for i, cue in enumerate(out):
        limit = (out[i + 1]["start"] - GAP_SEC) if i + 1 < len(out) else cue["end"] + min_duration
        limit = max(limit, cue["end"])
        need_dur = max(min_duration, len(cue["text"].replace("\n", "")) / max_cps)
        if cue["end"] - cue["start"] < need_dur:
            cue["end"] = round(min(cue["start"] + need_dur, limit), 3)
        cps = len(cue["text"].replace("\n", "")) / max(cue["end"] - cue["start"], 0.001)
        if cps > max_cps:
            # 구간을 더 늘릴 수 없으면 읽기 속도를 못 맞춘다. 숨기지 말고 표시한다.
            cue["warn"] = f"읽기 속도 초과 ({cps:.1f} cps > {max_cps})"
    return out


def _self_test():
    checks = []

    def check(name, cond, detail=""):
        checks.append((name, cond, detail))

    r = split_text("저희 한의원에서는 다이어트 한약을 처방할 때 체질을 먼저 봅니다", 20)
    check("어절 경계로만 나눔", all(" " in p or len(p) <= 20 for p in r) and
          "".join(r).replace(" ", "") == "저희한의원에서는다이어트한약을처방할때체질을먼저봅니다", r)
    check("단어 중간 안 자름", all(not p.startswith(tuple(PARTICLES)) for p in r[1:]), r)

    r = split_text("안녕하세요. 오늘은 다이어트 한약 이야기를 해보겠습니다.", 24)
    check("문장 끝 우선", r[0] == "안녕하세요.", r)

    r = split_text("체질을 먼저 봅니다 그런데 사람마다 체질이 다릅니다", 20)
    check("접속어는 다음 조각 첫머리", any(p.startswith("그런데") for p in r), r)

    r = split_text("한의원에서는상담을먼저진행합니다그리고체질검사를합니다", 12)
    check("강제 분할 시 조사 고립 없음", all(not p.startswith(tuple(PARTICLES)) for p in r[1:]), r)

    check("짧은 문장은 그대로", split_text("안녕하세요", 20) == ["안녕하세요"])
    check("빈 입력 처리", split_text("   ", 20) == [])

    w = wrap_lines("저희 한의원에서는 다이어트 한약을 처방합니다", 14, 2)
    lines = w.split("\n")
    check("2줄 래핑, 각 줄 길이 준수", len(lines) == 2 and all(len(l) <= 14 for l in lines), w)

    long_text = ("저희 한의원에서는 다이어트 한약을 처방할 때 체질을 먼저 봅니다 "
                 "그런데 사람마다 체질이 다르기 때문에 같은 처방을 드리지 않습니다")
    r = split_text(long_text, 32)
    check("자투리 조각 안 생김", min(len(p) for p in r) >= 0.4 * max(len(p) for p in r),
          [len(p) for p in r])

    cues = split_cues([{"start": 0.0, "end": 6.0,
                        "text": "저희 한의원에서는 다이어트 한약을 처방할 때 체질을 먼저 봅니다"}],
                      max_chars=20, max_lines=1)
    check("자막이 발화보다 먼저 뜨지 않음", all(c["start"] >= c["source_start"] - 1e-6 for c in cues), cues)
    check("조각들이 시간순 연속", all(cues[i]["end"] <= cues[i + 1]["start"] + 1e-6
                                for i in range(len(cues) - 1)), cues)

    two = split_cues([{"start": 0.0, "end": 8.4, "text": long_text},
                      {"start": 9.0, "end": 11.0, "text": "네 맞습니다."}], max_chars=16)
    check("자막끼리 겹치지 않음", all(two[i]["end"] <= two[i + 1]["start"] + 1e-6
                              for i in range(len(two) - 1)), two)
    check("모든 자막이 최소 노출 시간 충족",
          all(c["end"] - c["start"] >= 1.0 - 1e-6 for c in two),
          [(c["text"][:8], round(c["end"] - c["start"], 2)) for c in two])

    short = split_cues([{"start": 0.0, "end": 0.3, "text": "네"}], min_duration=1.0)
    check("최소 노출 시간 확보", short[0]["end"] - short[0]["start"] >= 1.0, short)

    failed = [(n, d) for n, ok, d in checks if not ok]
    for name, ok, _ in checks:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}")
    if failed:
        print(f"\n{len(failed)}개 실패:", file=sys.stderr)
        for name, detail in failed:
            print(f"  - {name}: {detail}", file=sys.stderr)
        return 1
    print(f"\n{len(checks)}개 전부 통과")
    return 0


def main():
    ap = argparse.ArgumentParser(description="한국어 자막을 문맥 경계에서 분할")
    ap.add_argument("infile", nargs="?", help="입력 JSON (생략 시 표준입력)")
    ap.add_argument("--max-chars", type=int, default=20, help="한 줄 최대 글자 수 (세로 영상은 12 근처)")
    ap.add_argument("--max-lines", type=int, default=2)
    ap.add_argument("--min-duration", type=float, default=1.0, help="자막 최소 노출 시간(초)")
    ap.add_argument("--max-cps", type=float, default=9.0, help="초당 읽기 글자 수 상한")
    ap.add_argument("--self-test", action="store_true", help="분할 규칙 회귀 확인")
    args = ap.parse_args()

    if args.self_test:
        return _self_test()

    raw = open(args.infile, encoding="utf-8").read() if args.infile else sys.stdin.read()
    cues = json.loads(raw)
    result = split_cues(cues, args.max_chars, args.max_lines, args.min_duration, args.max_cps)
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")

    warned = [c for c in result if "warn" in c]
    if warned:
        print(f"경고: {len(warned)}개 자막이 읽기 속도 상한을 넘습니다. "
              f"발화가 빠른 구간이므로 표시 시간을 늘리거나 문장을 줄이세요.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
