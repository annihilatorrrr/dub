import { DubApiError, ErrorCodes } from "@/lib/api/errors";
import { createLink, processLink } from "@/lib/api/links";
import { getProgramEnrollmentOrThrow } from "@/lib/api/programs/get-program-enrollment-or-throw";
import { parseRequestBody } from "@/lib/api/utils";
import { withPartnerProfile } from "@/lib/auth/partner";
import { createPartnerLinkSchema } from "@/lib/zod/schemas/partners";
import { PartnerLinkSchema } from "@/lib/zod/schemas/programs";
import { prisma } from "@dub/prisma";
import { getApexDomain } from "@dub/utils";
import { NextResponse } from "next/server";

// GET /api/partner-profile/programs/[programId]/links - get a partner's links in a program
export const GET = withPartnerProfile(async ({ partner, params }) => {
  const { links } = await getProgramEnrollmentOrThrow({
    partnerId: partner.id,
    programId: params.programId,
  });

  return NextResponse.json(links.map((link) => PartnerLinkSchema.parse(link)));
});

// POST /api/partner-profile/[programId]/links - create a link for a partner
export const POST = withPartnerProfile(
  async ({ partner, params, req, session }) => {
    const { url, key, comments } = createPartnerLinkSchema
      .pick({ url: true, key: true, comments: true })
      .parse(await parseRequestBody(req));

    const { program, tenantId } = await getProgramEnrollmentOrThrow({
      partnerId: partner.id,
      programId: params.programId,
    });

    if (!program.domain || !program.url) {
      throw new DubApiError({
        code: "bad_request",
        message:
          "You need to set a domain and url for this program before creating a partner.",
      });
    }

    if (url && getApexDomain(url) !== getApexDomain(program.url)) {
      throw new DubApiError({
        code: "bad_request",
        message: `The provided URL domain (${getApexDomain(url)}) does not match the program's domain (${getApexDomain(program.url)}).`,
      });
    }

    const workspace = await prisma.project.findUnique({
      select: {
        id: true,
        plan: true,
      },
      where: {
        id: program.workspaceId,
      },
    });

    if (!workspace) {
      throw new DubApiError({
        code: "bad_request",
        message: "Workspace not found for program.",
      });
    }

    const { link, error, code } = await processLink({
      payload: {
        domain: program.domain,
        key: key || undefined,
        url: url || program.url,
        programId: program.id,
        tenantId,
        partnerId: partner.id,
        folderId: program.defaultFolderId,
        comments,
        trackConversion: true,
      },
      workspace: workspace as any,
      userId: session.user.id,
      skipProgramChecks: true, // skip this cause we've already validated the program above
    });

    if (error != null) {
      throw new DubApiError({
        code: code as ErrorCodes,
        message: error,
      });
    }

    const partnerLink = await createLink(link);

    return NextResponse.json(partnerLink, { status: 201 });
  },
);
