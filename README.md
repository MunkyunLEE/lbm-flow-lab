# LBM Flow Lab

브라우저에서 바로 실행되는 2D 격자 볼츠만(Lattice Boltzmann Method) 유동 시뮬레이터입니다.
설치 없이 링크만 열면 형상을 배치하고, 경계조건을 지정하고, 유동을 계산해 GIF로 저장할 수 있습니다.

- 계산은 모두 브라우저(Web Worker) 안에서 이루어지며, 불러온 DXF 파일은 어디에도 전송되지 않습니다.
- 서버나 빌드 과정이 없는 정적 페이지라 GitHub Pages에 그대로 올라갑니다.

## 기능

| 단계 | 내용 |
|---|---|
| 격자판 | 한 변 길이 L [mm], 분할 수 N (기본 10 m, 500×500) |
| 유체 | 데모(층류) / 공기 / 물 / 사용자 정의 ν, ρ, Smagorinsky LES |
| 장애물 | DXF 불러오기, 클릭 선택, 드래그 이동, 핸들 회전(Shift = 15°), 배율, 삭제, 복셀 미리보기 |
| 경계조건 | 변별 속도 / 압력 / 유출 / 벽 / 미끄럼벽, 테두리 드래그로 구간(patch) 지정 |
| 결과 | 속도 크기, 와도, 압력 실시간 표시, 범례, GIF 저장 |
| 예제 | 90° 곡관, 2중 곡관 (안내날개 유/무) |

### DXF 지원 요소

LINE, LWPOLYLINE(호 구간 포함), POLYLINE, CIRCLE, ARC, ELLIPSE, SPLINE(유리 NURBS 포함), INSERT(블록).
닫힌 커브는 내부가 고체, 열린 커브는 1셀 두께 벽으로 처리됩니다. 단위는 `$INSUNITS`를 읽어 mm로 변환합니다.

## 솔버

- D2Q9, 정칙화(Regularized) BGK + 선택적 Smagorinsky LES
- 벽: halfway bounce-back / 속도·압력 경계: 비평형 외삽(Guo) / 유출: zero-gradient / 미끄럼벽: 대칭 반사
- 압력·유출 변 안쪽 흡수층: 밀도와 단면 평균 유출속도만 이완해 반사 음파 제거
- 단위 변환: Δt = u<sub>lat,max</sub>·Δx / U<sub>max</sub>, τ₀ = 3ν·Δt/Δx² + 0.5
- 셀 중심 규약: i번째 셀 중심 = (i + 0.5)·Δx

2D 해석이므로 실스케일 공기·물(고 Re)의 정량 해석보다는 유동 패턴과 상대 비교 용도에 적합합니다.

## 로컬 실행

모듈 Web Worker를 사용하므로 파일을 더블클릭(`file://`)하면 동작하지 않습니다. 간단한 로컬 서버로 여세요.

```bash
python -m http.server 8000
# 브라우저에서 http://localhost:8000
```

## 구조

```
index.html
css/style.css
js/api.js            /api/* 요청을 Web Worker로 전달
js/app.js            격자판 편집기 UI
js/worker.js         해석 실행 루프, 프레임 기록, API 처리
js/lbm/solver.js     D2Q9 솔버, 경계 필드, 단위 변환
js/lbm/geometry.js   셀 중심 복셀화
js/lbm/dxf.js        DXF 파서
js/lbm/render.js     컬러맵, 양자화, GIF 생성
js/vendor/gifenc     GIF 인코더 (MIT, Matt DesLauriers)
samples/             샘플 DXF, 예제 케이스 JSON
```

## 지원 브라우저

최신 Chrome, Edge, Firefox, Safari (모듈 Web Worker, OffscreenCanvas 필요)
