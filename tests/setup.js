// 모든 테스트 공통 — 개발자 PC 에 Ollama 가 켜져 있어도 테스트가 실제 모델을 부르지 않게 한다
process.env.CONDUIT_LLM_AUTODETECT = 'off';
