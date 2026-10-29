# LBM Flow Lab

브라우저에서 바로 실행되는 2D 격자 볼츠만(Lattice Boltzmann Method) 유동 시뮬레이터입니다.
설치 없이 링크만 열면 형상을 배치하고, 경계조건과 유입·유출 영역을 지정하고, 유동과 물체 하중을 계산하고, 바람에 움직이는 구조물(간이 FSI)까지 볼 수 있습니다.

- 계산은 모두 브라우저(Web Worker) 안에서 이루어지며, 불러온 DXF 파일은 어디에도 전송되지 않습니다.
- 서버나 빌드 과정이 없는 정적 페이지라 GitHub Pages에 그대로 올라갑니다.

## 기능

| 단계 | 내용 |
|---|---|
| 격자판 | 가로 Lx × 세로 Ly [mm], 가로 분할 수 Nx (셀 상한 100만) |
| 유체 | 데모(층류) / 공기 / 물 / 사용자 정의 ν, ρ, Smagorinsky LES |
| 객체 | DXF 불러오기, 선택·이동·회전·배율·삭제, 복셀 미리보기 |
| 객체 역할 | 고체 / 유입 영역(방사형·균일 벡터) / 유출 영역(압력) |
| Kinematics (FSI) | 객체별 OFF(고정) / 자유 회전 / 힌지(스프링) / 강제 회전(rpm), 회전축 캔버스 지정, 물성 프리셋 + 고급 설정 |
| 경계조건 | 변별 속도 / 압력 / 유출 / 벽 / 미끄럼벽, 테두리 드래그로 구간(patch) 지정 |
| 결과 | 속도 크기, 와도, 압력 + 속도 벡터, 유선, 입자(유맥선) |
| 물체 하중 | Fx, Fy, M, Cd, Cl 표와 시계열 그래프 (각도·회전수 포함) |
| GIF | 필드 + 벡터·입자·움직이는 객체 윤곽, 범례 포함 |
| 테마 | 다크 / 라이트 / 시스템 설정 (기본 다크) |
| 예제 | 바람에 도는 로터, 힌지 판, 실내 급·배기, 90° 곡관, 2중 곡관 |

### DXF 지원 요소

LINE, LWPOLYLINE(호 구간 포함), POLYLINE, CIRCLE, ARC, ELLIPSE, SPLINE(유리 NURBS 포함), INSERT(블록).
닫힌 커브는 내부가 고체(또는 유입/유출 영역), 열린 커브는 1셀 두께 벽입니다. Kinematics가 켜진 객체는 두께 0 경계(IBM)로 처리됩니다.

## 솔버

- D2Q9, 정칙화(Regularized) BGK + 선택적 Smagorinsky LES
- 벽: halfway bounce-back / 속도·압력 경계: 비평형 외삽(Guo) / 유출: zero-gradient / 미끄럼벽: 대칭 반사
- 유입·유출 영역: 영역 셀의 평형 분포를 지정 속도·압력으로 교체 (방사형 유입은 질량 생성)
- 압력·유출 변 안쪽 흡수층: 밀도와 단면 평균 유출속도만 이완해 반사 음파 제거
- 물체 하중: 운동량 교환법 / FSI: IBM 직접 강제법(3회 반복) + 강체 1축 회전(반암시적 적분)
- 단위 변환: Δt = u<sub>lat,max</sub>·Δx / U<sub>max</sub>, τ₀ = 3ν·Δt/Δx² + 0.5

### 검증

| 항목 | 결과 |
|---|---|
| Python 기준 솔버 대비 | 최대 차이 4×10⁻⁶ |
| 방사형 분출 u<sub>r</sub>·r = Q/2π | 오차 0.5% 이내 |
| 원기둥 Re 100 (막힘비 8%) | C<sub>d</sub> 1.38, C<sub>l</sub> 진폭 0.334, St 0.172 |
| IBM 토크 vs 고정벽 토크 | 부호·크기 일치 |

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
js/worker.js         해석 실행 루프, 프레임·하중 기록, API 처리
js/lbm/solver.js     D2Q9 솔버, 경계·영역 필드, 하중, IBM 강제
js/lbm/ibm.js        IBM 강체(회전축, 관성, 스프링, 감쇠)
js/lbm/geometry.js   셀 중심 복셀화, 영역 법선
js/lbm/flowviz.js    유선, 입자
js/lbm/dxf.js        DXF 파서
js/lbm/render.js     컬러맵, 양자화, GIF 생성
js/vendor/gifenc     GIF 인코더 (MIT, Matt DesLauriers)
samples/             샘플 DXF, 예제 케이스 JSON
docs/PLAN_3D.md      3D 및 간이 FSI 계획
```

## 지원 브라우저

최신 Chrome, Edge, Firefox, Safari (모듈 Web Worker, OffscreenCanvas 필요)
