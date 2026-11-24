import { KubeContentType, KubeMethod, type IKubeTransport } from '@pragmatic-tech-ai/pragmatic-kube'
import { ConsoleIntentLink } from '@pragmatic-tech-ai/pragmatic-hive-protocol'

/**
 * Whether a bearer is the hive agent's projected service-account token (C3.4): a TokenReview for the audience
 * `pragmatic-tenant-admin` must authenticate it as exactly the agent's service account. Anything else (no bearer,
 * another account, another audience, the review failing) is not the agent. The token is never logged.
 */
export class AgentCallerCheck
{
    private static readonly BearerPattern = /^Bearer ([A-Za-z0-9._-]{16,8192})$/
    private static readonly TokenReviewPath = '/apis/authentication.k8s.io/v1/tokenreviews'
    private static readonly TokenReviewApi = 'authentication.k8s.io/v1'
    private static readonly TokenReviewKind = 'TokenReview'
    private static readonly StatusOkMin = 200
    private static readonly StatusOkMax = 299

    public constructor(private readonly kube: IKubeTransport, private readonly agentUsername: string)
    {
    }

    public async IsAgent(authorization: string | undefined): Promise<boolean>
    {
        const A = AgentCallerCheck
        const token = A.BearerPattern.exec(authorization ?? '')?.[1]
        if (token === undefined)
        {
            return false
        }
        try
        {
            const body = JSON.stringify({ apiVersion: A.TokenReviewApi, kind: A.TokenReviewKind, spec: { token, audiences: [ConsoleIntentLink.Audience] } })
            const response = await this.kube.Send(KubeMethod.Post, A.TokenReviewPath, body, KubeContentType.Json)
            if (response.status < A.StatusOkMin || response.status > A.StatusOkMax)
            {
                return false
            }
            const status = (JSON.parse(response.body) as { status?: { authenticated?: boolean; audiences?: string[]; user?: { username?: string } } }).status
            return status?.authenticated === true
                && status.user?.username === this.agentUsername
                && (status.audiences ?? []).includes(ConsoleIntentLink.Audience)
        }
        catch
        {
            return false
        }
    }
}
