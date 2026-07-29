const INTERNAL_ERROR_MESSAGE = "服务暂时不可用，请稍后重试";

function clientErrorStatus(error) {
  if (error?.expose === false) return null;
  const statusCode = Number(error?.statusCode);
  return Number.isInteger(statusCode) && statusCode >= 400 && statusCode < 500
    ? statusCode
    : null;
}

export function createPublicErrorResponse(error, requestId) {
  const statusCode = clientErrorStatus(error);
  if (statusCode) {
    return {
      statusCode,
      body: {
        code: "REQUEST_ERROR",
        message: String(error?.message || "请求无法处理"),
        requestId
      }
    };
  }

  return {
    statusCode: 500,
    body: {
      code: "INTERNAL_ERROR",
      message: INTERNAL_ERROR_MESSAGE,
      requestId
    }
  };
}
