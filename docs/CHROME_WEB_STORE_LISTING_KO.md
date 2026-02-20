# Chrome Web Store Listing (KO) - ReviewMate

이 문서는 Chrome Web Store 등록 시 바로 붙여넣을 수 있는 한글 설명문 초안입니다.

## 확장 프로그램 이름

ReviewMate - GitHub PR AI Review Helper

## 한 줄 소개 (132자 이내)

GitHub PR Files 화면에서 선택 코드/PR 문맥을 바탕으로 AI와 대화하며 리뷰 코멘트, 리스크, 테스트 케이스를 빠르게 작성합니다.

## 상세 설명

ReviewMate는 GitHub Pull Request 리뷰 화면에서 코드 이해와 리뷰 품질 향상을 돕는 Chrome 확장 프로그램입니다.

주요 기능

- GitHub PR 화면 우측 패널에서 바로 AI 채팅
- 선택 코드 + PR 요약 + PR diff 기반 리뷰 분석
- 리포 전체 자동 탐색으로 선언/호출/아키텍처 맥락 보강
- 리뷰 코멘트 초안, 테스트 제안, 보안/리스크 분석 템플릿 제공
- Mermaid 다이어그램 자동 렌더링 및 코드/SVG 복사
- OpenAI 호환 API 지원 (`base_url`, `org_id`, `project_id`, 모델 설정)

이런 상황에서 유용합니다

- diff만으로는 변경 의도를 파악하기 어려운 PR
- 선언 위치가 멀리 떨어져 있어 리뷰 흐름이 끊기는 경우
- 리뷰 코멘트 품질(정확성/구체성/재현성)을 높이고 싶은 경우

주의 사항

- 확장은 사용자가 접근 가능한 GitHub 페이지의 코드/메타 정보를 읽어 문맥을 구성합니다.
- 사용자가 전송한 질문과 선택 코드/문맥은 설정한 LLM API 엔드포인트로 전송됩니다.
- 민감한 코드가 포함된 저장소에서는 내부 보안 정책에 따라 사용하세요.

## 카테고리 추천

Developer Tools

## 태그(선택)

github, pull request, code review, ai, openai, mermaid, developer tools

## 테스트 계정/검수 안내 (필요 시)

이 확장은 GitHub 로그인 상태에서 PR 페이지 접근 권한이 있어야 정상 동작합니다.

검수 단계

1. GitHub 로그인
2. 임의의 PR Files 화면 진입 (`https://github.com/<owner>/<repo>/pull/<n>/files`)
3. 우측 하단 `RM` 버튼 클릭
4. 옵션에서 API Key/Base URL 저장 후 채팅 전송

