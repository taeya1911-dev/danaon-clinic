# 간판 로고 리빌 4초 — 제작 사양서

정지 이미지(레퍼런스 플레이트) 한 장을 받아, **간판만** 켜지는 4초 VFX 리빌 클립을
만들기 위한 사양서. 장면을 다시 그리는 작업이 아니라, 고정된 플레이트에 얹는
합성 효과다.

마지막 갱신: 2026-07-30

---

## 핵심 제약 하나 — 레퍼런스는 **마지막 프레임**이다

브리프를 그대로 읽으면 이렇게 된다.

- 0.0초: 간판이 **비어 있다** (로고·글자·심볼 없음)
- 4.0초: 화면이 **업로드한 레퍼런스 이미지와 동일**하다

즉 레퍼런스 이미지는 시작 프레임이 아니라 **끝 프레임**이다.
레퍼런스를 `start_image`로 그냥 넣으면 0프레임부터 간판이 켜져 있어서
브리프의 타임라인이 성립하지 않는다.

그래서 2단계로 만든다.

| 단계 | 하는 일 | 결과물 |
|---|---|---|
| A. 소등 플레이트 | 레퍼런스에서 간판 그래픽만 지운다. 나머지 픽셀은 그대로. | `start_image` |
| B. 영상 생성 | A를 시작 프레임, 원본 레퍼런스를 끝 프레임으로 4초 보간 | 최종 클립 |

끝 프레임을 원본으로 고정하기 때문에 "마지막 프레임이 레퍼런스와 구분되지 않아야
한다"는 요구가 프롬프트 설득이 아니라 **구조적으로** 보장된다.

---

## A단계 — 소등 플레이트 만들기

모델: `gpt_image_2` (quality `high`) 또는 `flux_kontext`.
간판 영역만 지우고 나머지는 건드리지 않는 편집이므로, 텍스트/타이포 편집에 강한
쪽을 쓴다. 결과를 눈으로 확인하고 어긋나면 다른 모델로 재시도한다.

편집 프롬프트:

```
Remove only the sign graphics from the signboard: delete all lettering, logo
symbol, and icon so the signboard panel reads as blank and unlit.

Keep every other pixel identical to the input image — the storefront structure,
wall, ceiling, glass, interior, products, floor, camera angle, framing,
perspective, color grade, and the ambient lighting of the room must be
unchanged. Do not relight the scene, do not clean up or restyle anything,
do not add any new element.

The blank signboard panel should show its own base material and mounting
exactly as it would look with the sign switched off — no glow, no halo,
no residual text ghosting, no placeholder shape.
```

검수 기준: 간판 영역 밖의 픽셀이 육안으로 달라진 곳이 없어야 한다.
특히 조명 톤, 반사, 진열 내용물이 바뀌면 B단계에서 배경이 흔들린다.

---

## B단계 — 영상 생성

모델: `seedance_2_0`
`start_image` + `end_image`를 동시에 받고, 4초 길이와 1080p를 지원한다.

| 파라미터 | 값 | 이유 |
|---|---|---|
| `duration` | `4` | 브리프 명세 |
| `resolution` | `1080p` | 상업용 납품 |
| `mode` | `std` | 1080p는 `std`에서만 가능 |
| `bitrate_mode` | `high` | 미세 플리커가 압축에 뭉개지지 않게 |
| `generate_audio` | `false` | 무음 클립. 브리프에 소리 요구 없음 |
| `genre` | `auto` | 장르 연출이 들어가면 카메라가 과해진다 |
| `aspect_ratio` | `auto` | 레퍼런스 비율을 그대로 유지 |
| `medias` | `start_image` = 소등 플레이트, `end_image` = 원본 레퍼런스 | |

생성 프롬프트:

```
Locked-off VFX reveal on a static plate. Premium retail signage power-on,
clean, realistic, subtle, high-end brand presentation.

Only the storefront sign animates. The storefront, wall, ceiling, glass,
interior, products, floor, reflections, ambient lighting, camera angle,
framing, and perspective stay visually fixed for the entire shot.

One continuous shot, no cuts. Camera holds the reference framing with only a
very subtle, slow side-to-side micro-tilt — a few pixels of drift, smooth and
minimal, running gently from the first frame to the last. No zoom, no push-in,
no reframing, no handheld shake.

0.0-0.6s: the signboard panel is blank and unlit, no lettering, no logo, no
symbol. Everything else already looks exactly like the final frame. The micro-
tilt begins.

0.6-2.8s: the sign powers on in its exact original position, revealing its
elements one at a time in natural reading order, left to right. Each letter and
logo element flickers once or twice like a backlit storefront sign striking on,
then settles into a steady illuminated state. Backlit illumination rising in
place — nothing flies in, slides in, assembles, draws on, or is rebuilt.

2.8-4.0s: the sign is fully lit, complete, and stable, matching the reference
exactly. Hold while the subtle micro-tilt continues gently to the end.

The sign keeps its original design, position, scale, spacing, colors, icon,
and typography throughout. The final frame is indistinguishable from the
reference image.
```

부정 프롬프트 (모델이 별도 필드를 지원하면 분리, 아니면 위 프롬프트 뒤에 붙인다):

```
No camera angle or framing change beyond the subtle micro-tilt. No zoom, no
dolly, no shake, no cut, no transition. Sign does not move to a different
position in frame. No redesigned, restyled, replaced, distorted, or simplified
logo. No extra text, letters, words, objects, people, or props. No change to
the storefront architecture, materials, background, interior, or lighting
setup. No dramatic strobing, heavy bloom, lens flare, light rays, particles,
sparkles, or smoke. No fast motion, no speed ramp, no color grade shift.
```

---

## 검수 체크리스트

- [ ] 0프레임: 간판이 비어 있고 배경은 레퍼런스와 동일한가
- [ ] 마지막 프레임: 레퍼런스와 육안으로 구분되지 않는가
- [ ] 로고의 위치·크기·자간·색·아이콘·서체가 원본 그대로인가
- [ ] 리빌이 "빛이 켜지는" 느낌인가 (요소가 날아들거나 그려지지 않는가)
- [ ] 플리커가 각 요소당 1~2회인가 (스트로브처럼 과하지 않은가)
- [ ] 카메라 이동이 미세한 좌우 틸트뿐인가
- [ ] 배경·조명·반사·진열이 클립 내내 고정인가
- [ ] 없던 글자나 물체가 생기지 않았는가

한 번에 통과하지 못하는 게 정상이다. 실패 지점별 대응:

| 증상 | 손볼 곳 |
|---|---|
| 배경이 흔들리거나 다시 그려짐 | A단계 소등 플레이트를 다시 만든다. 배경이 이미 달랐을 가능성이 크다 |
| 마지막 프레임이 레퍼런스와 다름 | `end_image`가 제대로 들어갔는지 확인 |
| 로고 모양이 변형됨 | A단계 플레이트에 글자 잔상이 남았는지 확인 |
| 카메라가 과하게 움직임 | 프롬프트에서 micro-tilt 문장을 더 줄이고 부정 프롬프트를 강화 |
| 플리커가 과함 | "flickers once or twice" → "flickers once" |

---

## 실행 메모

- 레퍼런스 이미지는 Higgsfield 스토리지에 올라가 있어야 한다.
  로컬 파일이면 `media_upload_widget`으로 올리고 반환된 `media_id`를 쓴다.
  생성 도구의 `medias[].value`에는 URL이 아니라 `media_id`를 넣는다.
- 이 컨테이너의 네트워크 정책은 Higgsfield CDN(`d2ol7oe51mr4n9.cloudfront.net`)
  접근을 막는다. 결과물 확인은 반환된 링크를 사람이 직접 열어서 한다.
