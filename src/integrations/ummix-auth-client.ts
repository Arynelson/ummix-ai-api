export class UmmixAuthClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'UmmixAuthClientError';
  }
}

export class UmmixAuthClient {
  constructor(private readonly baseUrl: string) {}

  async getCurrentUser(accessToken: string): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.baseUrl}/users/me`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const status = response.status === 401 || response.status === 403 ? 401 : 502;
      throw new UmmixAuthClientError(
        status === 401 ? 'Sessão Ummix inválida ou expirada' : 'Serviço de autenticação indisponível',
        status,
      );
    }

    const user = (await response.json()) as Record<string, unknown>;
    if (typeof user.id !== 'string' || !user.id) {
      throw new UmmixAuthClientError('Resposta de autenticação inválida', 502);
    }
    return user;
  }
}
