#!/usr/bin/env python3
"""무음 구간을 찾아 "삭제 / 축소 / 보존" 계획을 만든다.

음량만 보고 자르면 말없이 시연하는 구간이 통째로 날아간다. 그래서 무음 감지 결과와
장면 변화 감지 결과를 겹쳐 보고, 화면이 움직이는 무음은 보존한다.
판정마다 사유를 남기므로 로그만 읽고 오판을 잡아낼 수 있다.

  python silence_plan.py INPUT.mp4 --config config/defaults.yaml --out cut_plan.json
  python silence_plan.py INPUT.mp4 --keep 00:01:23-00:01:45 --keep 00:04:10-00:04:30
  python silence_plan.py --from-json probe.json --duration 300   # ffmpeg 없이 판정만
  python silence_plan.py --self-test

--from-json 은 {"silences": [[s,e],...], "scenes": [t,...]} 형식을 받는다.
ffmpeg 호출부가 환경에 안 맞을 때 탐지와 판정을 분리해 쓰기 위한 것이다.
"""

import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys

DEFAULTS = {
    "silence_threshold_db": -35.0,
    "min_silence_sec": 0.8,
    "keep_silence_sec": 0.5,
    "pad_before_sec": 0.15,
    "pad_after_sec": 0.25,
    "min_clip_sec": 1.0,
    "scene_change_threshold": 0.30,
}


# ─────────────────────────── 입력 파싱 ───────────────────────────

def parse_timecode(value):
    """'00:01:23.5' / '1:23' / '83.5' 를 초로."""
    value = str(value).strip()
    if not value:
        raise ValueError("빈 시각")
    parts = value.split(":")
    if len(parts) > 3:
        raise ValueError(f"시각 형식을 알 수 없음: {value}")
    total = 0.0
    for part in parts:
        total = total * 60 + float(part)
    return total


def parse_keep_ranges(items):
    ranges = []
    for item in items or []:
        if "-" not in item:
            raise ValueError(f"--keep 은 시작-끝 형식이어야 함: {item}")
        a, b = item.split("-", 1)
        start, end = parse_timecode(a), parse_timecode(b)
        if end <= start:
            raise ValueError(f"--keep 끝이 시작보다 앞: {item}")
        ranges.append((start, end))
    return ranges


def parse_silencedetect(text):
    """ffmpeg silencedetect 출력에서 무음 구간을 뽑는다."""
    starts = [float(m) for m in re.findall(r"silence_start:\s*(-?[\d.]+)", text)]
    ends = [float(m) for m in re.findall(r"silence_end:\s*(-?[\d.]+)", text)]
    out = []
    for i, start in enumerate(starts):
        end = ends[i] if i < len(ends) else None
        if end is not None and end > start:
            out.append((max(0.0, start), end))
    return out


def parse_scene_times(text):
    """장면 변화 시각을 뽑는다. showinfo와 metadata=print 출력 형식을 모두 받는다."""
    times = {round(float(m), 3) for m in re.findall(r"pts_time:\s*([\d.]+)", text)}
    return sorted(times)


# ─────────────────────────── ffmpeg 호출 ───────────────────────────

def _run(cmd):
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          text=True, errors="replace")
    return proc.stdout


def require_ffmpeg():
    missing = [b for b in ("ffmpeg", "ffprobe") if not shutil.which(b)]
    if missing:
        raise SystemExit(
            f"{', '.join(missing)} 를 찾을 수 없습니다. ffmpeg 설치가 필요합니다.\n"
            "  macOS: brew install ffmpeg   /   Windows: winget install ffmpeg\n"
            "설치 없이 판정 로직만 쓰려면 --from-json 으로 탐지 결과를 넘기세요."
        )


def probe_duration(path):
    out = _run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
                "-of", "default=noprint_wrappers=1:nokey=1", path]).strip()
    try:
        return float(out.splitlines()[-1])
    except (ValueError, IndexError):
        raise SystemExit(f"영상 길이를 읽지 못했습니다: {path}\n{out}")


def detect_silences(path, threshold_db, min_sec):
    text = _run(["ffmpeg", "-hide_banner", "-nostats", "-i", path,
                 "-af", f"silencedetect=noise={threshold_db}dB:d={min_sec}",
                 "-f", "null", "-"])
    return parse_silencedetect(text)


def detect_scenes(path, threshold):
    text = _run(["ffmpeg", "-hide_banner", "-nostats", "-i", path,
                 "-vf", f"select='gt(scene,{threshold})',showinfo",
                 "-an", "-f", "null", "-"])
    return parse_scene_times(text)


# ─────────────────────────── 판정 ───────────────────────────

def _overlaps(a_start, a_end, b_start, b_end):
    return a_start < b_end and b_start < a_end


def plan(duration, silences, scenes, cfg, keep_ranges=()):
    """무음 구간별로 삭제/축소/보존을 정하고 최종 컷 계획을 만든다."""
    keep_total_min = cfg["pad_after_sec"] + cfg["pad_before_sec"]
    decisions = []

    for start, end in sorted(silences):
        start, end = max(0.0, start), min(duration, end)
        length = end - start
        item = {"start": round(start, 3), "end": round(end, 3), "length": round(length, 3)}

        manual = next((r for r in keep_ranges if _overlaps(start, end, *r)), None)
        inside = [t for t in scenes if start < t < end]

        if manual:
            item.update(action="보존", reason=f"사용자 지정 보존 구간과 겹침 ({manual[0]:.1f}-{manual[1]:.1f}s)")
        elif inside:
            # 말은 없지만 화면이 움직인다 — 시연이나 화면 전환일 가능성이 높다.
            item.update(action="보존", reason=f"화면 변화 {len(inside)}회 감지 (무언 시연 추정)",
                        scene_changes=[round(t, 3) for t in inside])
        elif length < cfg["min_silence_sec"]:
            item.update(action="보존", reason=f"최소 무음 길이({cfg['min_silence_sec']}s) 미만")
        else:
            keep_total = max(cfg["keep_silence_sec"], keep_total_min)
            if keep_total >= length:
                item.update(action="보존", reason="이미 남길 길이보다 짧음")
            else:
                extra = (keep_total - keep_total_min) / 2.0
                head = cfg["pad_after_sec"] + extra   # 앞 발화 뒤 여백
                tail = cfg["pad_before_sec"] + extra  # 다음 발화 앞 여백
                item.update(action="축소", reason=f"{length:.2f}s → {keep_total:.2f}s",
                            remove=[round(start + head, 3), round(end - tail, 3)])
        decisions.append(item)

    # 컷을 너무 잘게 내면 영상이 딸꾹질한다. 짧은 클립이 생기는 컷은 취소한다.
    for _ in range(len(decisions) + 1):
        removals = [d["remove"] for d in decisions if d.get("remove")]
        clips = _clips_from(removals, duration)
        bad = next((i for i, c in enumerate(clips) if c[1] - c[0] < cfg["min_clip_sec"]), None)
        if bad is None:
            break
        # 그 클립을 만들어낸 앞쪽 컷을 취소해 앞 클립과 붙인다
        target = removals[bad - 1] if bad > 0 else (removals[0] if removals else None)
        if target is None:
            break
        for d in decisions:
            if d.get("remove") == target:
                d["action"] = "보존"
                d["reason"] = f"컷하면 클립이 {cfg['min_clip_sec']}s 미만이 되어 취소"
                d.pop("remove", None)
                break

    removals = [d["remove"] for d in decisions if d.get("remove")]
    clips = _clips_from(removals, duration)
    removed_total = sum(b - a for a, b in removals)

    return {
        "duration": round(duration, 3),
        "config": cfg,
        "decisions": decisions,
        "removals": [[round(a, 3), round(b, 3)] for a, b in removals],
        "clips": [[round(a, 3), round(b, 3)] for a, b in clips],
        "stats": {
            "silence_count": len(decisions),
            "cut_count": len(removals),
            "kept_count": sum(1 for d in decisions if d["action"] == "보존"),
            "removed_sec": round(removed_total, 3),
            "result_duration": round(duration - removed_total, 3),
            "removed_ratio": round(removed_total / duration, 4) if duration else 0.0,
        },
    }


def _clips_from(removals, duration):
    clips, cursor = [], 0.0
    for a, b in sorted(removals):
        if a > cursor:
            clips.append((cursor, a))
        cursor = max(cursor, b)
    if cursor < duration:
        clips.append((cursor, duration))
    return clips


def render_log(result):
    lines = [f"영상 길이 {result['duration']:.1f}s → 결과 {result['stats']['result_duration']:.1f}s "
             f"({result['stats']['removed_ratio'] * 100:.1f}% 삭제, 컷 {result['stats']['cut_count']}개)", ""]
    for d in result["decisions"]:
        lines.append(f"  [{d['action']}] {d['start']:7.2f} ~ {d['end']:7.2f}s "
                     f"({d['length']:5.2f}s)  {d['reason']}")
    kept = result["stats"]["kept_count"]
    if kept:
        lines += ["", f"보존 {kept}개 — 잘려야 할 게 보존됐거나 그 반대면 "
                      f"scene_change_threshold / min_silence_sec 을 조정하세요."]
    return "\n".join(lines)


# ─────────────────────────── 설정 ───────────────────────────

def load_config(path):
    cfg = dict(DEFAULTS)
    if not path:
        return cfg
    if not os.path.exists(path):
        raise SystemExit(f"설정 파일이 없습니다: {path}")
    text = open(path, encoding="utf-8").read()
    try:
        import yaml  # 있으면 쓰고
        data = yaml.safe_load(text) or {}
        flat = {}
        for section in data.values():
            if isinstance(section, dict):
                flat.update(section)
        flat.update({k: v for k, v in data.items() if not isinstance(v, dict)})
    except ImportError:
        # PyYAML 없이도 돌아야 한다. 필요한 건 "키: 숫자" 뿐이라 그것만 읽는다.
        flat = {}
        for line in text.splitlines():
            m = re.match(r"\s*([a-z_]+)\s*:\s*(-?[\d.]+)\s*(?:#.*)?$", line)
            if m:
                flat[m.group(1)] = float(m.group(2))
    for key in cfg:
        if key in flat and flat[key] is not None:
            cfg[key] = float(flat[key])
    return cfg


# ─────────────────────────── 자체 테스트 ───────────────────────────

def _self_test():
    checks = []

    def check(name, cond, detail=""):
        checks.append((name, cond, detail))

    text = ("[silencedetect @ 0x1] silence_start: 3.5\n"
            "[silencedetect @ 0x1] silence_end: 6.2 | silence_duration: 2.7\n"
            "[silencedetect @ 0x1] silence_start: 10.0\n"
            "[silencedetect @ 0x1] silence_end: 12.0 | silence_duration: 2.0\n")
    check("silencedetect 파싱", parse_silencedetect(text) == [(3.5, 6.2), (10.0, 12.0)],
          parse_silencedetect(text))
    check("끝나지 않은 무음은 버림",
          parse_silencedetect("silence_start: 5.0\n") == [])
    check("showinfo 파싱",
          parse_scene_times("n:1 pts_time:4.20 \nn:2 pts_time:11.00 ") == [4.2, 11.0])
    check("시각 파싱", abs(parse_timecode("00:01:23.5") - 83.5) < 1e-6)
    check("keep 범위 파싱", parse_keep_ranges(["00:00:10-00:00:20"]) == [(10.0, 20.0)])

    cfg = dict(DEFAULTS)

    # 핵심: 화면이 움직이는 무음은 살아남아야 한다
    r = plan(30.0, [(3.5, 6.2), (10.0, 14.0)], scenes=[11.5], cfg=cfg)
    by_start = {d["start"]: d for d in r["decisions"]}
    check("일반 무음은 축소", by_start[3.5]["action"] == "축소", by_start[3.5])
    check("화면 변화 있는 무음은 보존", by_start[10.0]["action"] == "보존", by_start[10.0])
    check("보존 사유에 시연 언급", "시연" in by_start[10.0]["reason"], by_start[10.0]["reason"])

    # 사용자 지정 보존이 화면 변화보다 우선
    r = plan(30.0, [(3.5, 6.2)], scenes=[], cfg=cfg, keep_ranges=[(3.0, 7.0)])
    check("--keep 구간은 보존", r["decisions"][0]["action"] == "보존", r["decisions"][0])

    # 짧은 무음은 건드리지 않음
    r = plan(30.0, [(5.0, 5.4)], scenes=[], cfg=cfg)
    check("최소 길이 미만은 보존", r["decisions"][0]["action"] == "보존", r["decisions"][0])

    # 축소 후 남는 무음이 keep_silence_sec 인지
    r = plan(30.0, [(3.0, 9.0)], scenes=[], cfg=cfg)
    a, b = r["decisions"][0]["remove"]
    remaining = (9.0 - 3.0) - (b - a)
    check("축소 후 무음이 설정값과 일치",
          abs(remaining - max(cfg["keep_silence_sec"],
                              cfg["pad_before_sec"] + cfg["pad_after_sec"])) < 1e-6, remaining)
    check("발화 직후 여백 확보", a - 3.0 >= cfg["pad_after_sec"] - 1e-9, a - 3.0)
    check("발화 직전 여백 확보", 9.0 - b >= cfg["pad_before_sec"] - 1e-9, 9.0 - b)

    # 짧은 클립을 만드는 컷은 취소
    r = plan(30.0, [(1.0, 5.0), (5.4, 9.0)], scenes=[], cfg=cfg)
    check("짧은 클립 생기는 컷은 취소",
          any("취소" in d["reason"] for d in r["decisions"]), r["decisions"])
    check("남은 클립이 전부 최소 길이 이상",
          all(b - a >= cfg["min_clip_sec"] - 1e-6 for a, b in r["clips"]), r["clips"])

    # 통계 정합성 — 검사기 7번 항목이 여기 의존한다
    r = plan(60.0, [(5.0, 12.0), (20.0, 30.0), (40.0, 41.0)], scenes=[25.0], cfg=cfg)
    total_clip = sum(b - a for a, b in r["clips"])
    check("클립 합 = 결과 길이", abs(total_clip - r["stats"]["result_duration"]) < 1e-6,
          (total_clip, r["stats"]["result_duration"]))
    check("클립이 서로 겹치지 않음",
          all(r["clips"][i][1] <= r["clips"][i + 1][0] + 1e-9 for i in range(len(r["clips"]) - 1)),
          r["clips"])
    check("무음 없으면 통째로 한 클립",
          plan(30.0, [], [], cfg)["clips"] == [[0.0, 30.0]])

    for name, ok, _ in checks:
        print(f"  {'PASS' if ok else 'FAIL'}  {name}")
    failed = [(n, d) for n, ok, d in checks if not ok]
    if failed:
        print(f"\n{len(failed)}개 실패:", file=sys.stderr)
        for name, detail in failed:
            print(f"  - {name}: {detail}", file=sys.stderr)
        return 1
    print(f"\n{len(checks)}개 전부 통과")
    return 0


def main():
    ap = argparse.ArgumentParser(description="무음 구간의 삭제/축소/보존 계획 생성")
    ap.add_argument("input", nargs="?", help="영상 파일")
    ap.add_argument("--config", help="config/defaults.yaml 경로")
    ap.add_argument("--out", help="계획 JSON 저장 경로 (생략 시 표준출력)")
    ap.add_argument("--keep", action="append", default=[],
                    help="강제 보존 구간. 00:01:23-00:01:45 형식, 여러 번 지정 가능")
    ap.add_argument("--from-json", help='{"silences":[[s,e]],"scenes":[t]} 형식의 탐지 결과')
    ap.add_argument("--duration", type=float, help="--from-json 과 함께 쓸 영상 길이(초)")
    ap.add_argument("--self-test", action="store_true")
    args = ap.parse_args()

    if args.self_test:
        return _self_test()

    cfg = load_config(args.config)
    keep_ranges = parse_keep_ranges(args.keep)

    if args.from_json:
        data = json.load(open(args.from_json, encoding="utf-8"))
        if args.duration is None:
            raise SystemExit("--from-json 을 쓸 때는 --duration 도 필요합니다.")
        duration = args.duration
        silences = [tuple(s) for s in data.get("silences", [])]
        scenes = list(data.get("scenes", []))
    else:
        if not args.input:
            raise SystemExit("영상 파일 경로가 필요합니다. (또는 --from-json)")
        if not os.path.exists(args.input):
            raise SystemExit(f"파일이 없습니다: {args.input}")
        require_ffmpeg()
        duration = probe_duration(args.input)
        silences = detect_silences(args.input, cfg["silence_threshold_db"], cfg["min_silence_sec"])
        scenes = detect_scenes(args.input, cfg["scene_change_threshold"])
        if not silences:
            print("무음 구간이 하나도 안 잡혔습니다. silence_threshold_db 를 올려보세요 "
                  f"(현재 {cfg['silence_threshold_db']}dB).", file=sys.stderr)

    result = plan(duration, silences, scenes, cfg, keep_ranges)
    print(render_log(result), file=sys.stderr)

    text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(text + "\n")
        print(f"\n계획 저장: {args.out}", file=sys.stderr)
    else:
        print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
