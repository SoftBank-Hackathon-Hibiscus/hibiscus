"""오류 코드와 종료 코드. 코드 이름은 IMPLEMENTATION_SPEC 23절을 따른다."""

EXIT_OK = 0
EXIT_ERROR = 1  # 잘못된 인자·스키마·실행 오류
EXIT_INCOMPLETE = 2  # 필요한 입력·팀 연결·권한이 없어 완료 불가 또는 inconclusive
EXIT_FAILED = 3  # 검사 실패 또는 패치 안전 검증 거부

_EXIT_BY_CODE = {
    "DOCKER_UNAVAILABLE": EXIT_INCOMPLETE,
    "PARITY_ADAPTER_MISSING": EXIT_INCOMPLETE,
    "CONTRACT_MISSING": EXIT_INCOMPLETE,
    "BUILD_ADAPTER_MISSING": EXIT_INCOMPLETE,
    "MISSING_REPLAY_SECRET": EXIT_INCOMPLETE,
    "AI_CREDENTIALS_MISSING": EXIT_INCOMPLETE,
    "AI_MODEL_MISSING": EXIT_INCOMPLETE,
    "AI_PROVIDER_UNAVAILABLE": EXIT_INCOMPLETE,
    "SCHEMA_UNCHECKED": EXIT_INCOMPLETE,
    "PATCH_PATH_DENIED": EXIT_FAILED,
    "PATCH_TOO_LARGE": EXIT_FAILED,
    "PATCH_AMBIGUOUS": EXIT_FAILED,
}


class PremortemError(Exception):
    """오류 코드가 붙은 실행 오류. 메시지에는 비밀값을 넣지 않는다."""

    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message

    @property
    def exit_code(self) -> int:
        return _EXIT_BY_CODE.get(self.code, EXIT_ERROR)
