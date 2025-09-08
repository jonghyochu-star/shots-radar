
# Shorts Radar — S3 Long Trend (GitHub Actions Skeleton)

이 패키지는 **GitHub Actions 크론으로 YouTube Data API를 수집 → `public/kw-trend.json`을 갱신 → GitHub Pages로 제공**하는 0원 인프라 골격입니다.

## 설치
1) 이 폴더 구조 그대로 리포에 복사/커밋
2) GitHub → Settings → Secrets and variables → Actions → **New repository secret** 로 아래 5개 저장
   - `YT_KEY_1` … `YT_KEY_5` (보유중인 API 키)
3) GitHub Pages 활성화 (Source: GitHub Actions or Deploy from Branch → `/(root)` 혹은 `/public`)
4) 워크플로 수동 실행(Workflow Dispatch)로 첫 빌드 수행
5) 프론트에서 `fetch('./kw-trend.json')` 로 연결

## 산출 스키마
```json
{
  "updatedAt": "YYYY-MM-DD",
  "series": {
    "정치":  [{"d":"YYYY-MM-DD","views":123456,"n":31}, ...],
    "AI":    [{"d":...}],
    "연예":  [],
    "스포츠": [],
    "커뮤니티": [],
    "게임": [],
    "시니어": [],
    "오피셜": [],
    "리뷰": []
  }
}
```
