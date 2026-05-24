# X Thread Clean Capture for Firefox

X/Twitter thread 페이지에서 주변 UI 없이 텍스트와 첨부 이미지를 포함한 깔끔한 PNG 이미지를 만드는 Firefox WebExtension입니다.

## 기능

- `x.com/.../status/...`, `twitter.com/.../status/...` 페이지에서 동작합니다.
- 트윗 페이지에서 확장 아이콘을 누르면 같은 작성자의 thread 트윗을 자동 스크롤로 수집합니다.
- 트윗 텍스트, 작성자, 핸들, 타임스탬프, 순서, 첨부 이미지를 추출합니다.
- 깔끔한 capture 페이지를 열어 thread 내용만 보여줍니다.
- **Download PNG**로 이미지 저장, **Copy text**로 텍스트 복사가 가능합니다.

## 의도적으로 제외한 것

- X 네비게이션, 사이드바, 답글/리트윗/좋아요 버튼, 광고, 추천 UI.
- 다른 사용자의 답글.
- 동영상/GIF의 실제 프레임 렌더링. 현재는 tweet photo 이미지(`pbs.twimg.com/media/...`)만 포함합니다.

## 제한사항

X는 동적 앱이라 긴 thread를 한 번에 모두 로드하지 않습니다. 확장이 자동 스크롤로 더 많은 트윗을 로드하지만, 매우 긴 thread나 X의 DOM 변경이 있으면 페이지 새로고침 후 다시 시도해야 할 수 있습니다.

로그인 우회, paywall, 보호 계정, 삭제/비공개 트윗 우회는 하지 않습니다. 현재 Firefox 세션에서 볼 수 있는 내용만 캡처합니다.

## Firefox에서 임시 설치

1. Firefox에서 `about:debugging#/runtime/this-firefox`를 엽니다.
2. **Load Temporary Add-on...**을 클릭합니다.
3. 이 폴더의 `manifest.json`을 선택합니다.
4. 특정 X/Twitter status URL을 열고 확장 아이콘을 클릭합니다.

참고: Temporary Add-on은 Firefox를 재시작하면 제거됩니다. 영구 설치하려면 Mozilla Add-ons 서명 또는 개발자용 서명 절차가 필요합니다.

## 패키지

`dist/x-thread-clean-capture-firefox-v1.0.0.zip` 파일은 `manifest.json`이 archive root에 오도록 만든 Firefox WebExtension ZIP입니다.

## 권한

- `activeTab`, `tabs`: 현재 X/Twitter 탭과 통신하고, 이미 열린 탭에 content script를 주입합니다.
- `storage`: 추출한 thread 데이터를 clean capture 페이지에 전달합니다.
- `https://pbs.twimg.com/*`: tweet 첨부 이미지를 Firefox extension background에서 가져와 PNG에 안전하게 포함합니다.
- host 권한은 `https://x.com/*`, `https://www.x.com/*`, `https://twitter.com/*`, `https://www.twitter.com/*`, `https://pbs.twimg.com/*`로 제한했습니다.

## License

MIT
