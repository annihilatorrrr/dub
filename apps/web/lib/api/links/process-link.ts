import { isBlacklistedDomain } from "@/lib/edge-config";
import { verifyFolderAccess } from "@/lib/folder/permissions";
import { checkIfUserExists, getRandomKey } from "@/lib/planetscale";
import { isNotHostedImage } from "@/lib/storage";
import { NewLinkProps, ProcessedLinkProps, WorkspaceProps } from "@/lib/types";
import { prisma } from "@dub/prisma";
import {
  DUB_DOMAINS,
  UTMTags,
  constructURLFromUTMParams,
  getApexDomain,
  getDomainWithoutWWW,
  getUrlFromString,
  isDubDomain,
  isValidUrl,
  parseDateTime,
  pluralize,
} from "@dub/utils";
import { combineTagIds } from "../tags/combine-tag-ids";
import { businessFeaturesCheck, proFeaturesCheck } from "./plan-features-check";
import { keyChecks, processKey } from "./utils";

export async function processLink<T extends Record<string, any>>({
  payload,
  workspace,
  userId,
  bulk = false,
  skipKeyChecks = false, // only skip when key doesn't change (e.g. when editing a link)
  skipExternalIdChecks = false, // only skip when externalId doesn't change (e.g. when editing a link)
  skipFolderChecks = false, // only skip for update / upsert links
  skipProgramChecks = false, // only skip for when program is already validated
}: {
  payload: NewLinkProps & T;
  workspace?: Pick<WorkspaceProps, "id" | "plan">;
  userId?: string;
  bulk?: boolean;
  skipKeyChecks?: boolean;
  skipExternalIdChecks?: boolean;
  skipFolderChecks?: boolean;
  skipProgramChecks?: boolean;
}): Promise<
  | {
      link: NewLinkProps & T;
      error: string;
      code?: string;
      status?: number;
    }
  | {
      link: ProcessedLinkProps & T;
      error: null;
      code?: never;
      status?: never;
    }
> {
  let {
    domain,
    key,
    keyLength,
    url,
    image,
    proxy,
    trackConversion,
    expiredUrl,
    tagNames,
    folderId,
    externalId,
    tenantId,
    partnerId,
    programId,
    webhookIds,
    testVariants,
  } = payload;

  let expiresAt: string | Date | null | undefined = payload.expiresAt;
  let testCompletedAt: string | Date | null | undefined =
    payload.testCompletedAt;

  let defaultProgramFolderId: string | null = null;
  const tagIds = combineTagIds(payload);

  // if URL is defined, perform URL checks
  if (url) {
    url = getUrlFromString(url);
    if (!isValidUrl(url)) {
      return {
        link: payload,
        error: "Invalid destination URL",
        code: "unprocessable_entity",
      };
    }
    if (UTMTags.some((tag) => payload[tag])) {
      const utmParams = UTMTags.reduce((acc, tag) => {
        if (payload[tag]) {
          acc[tag] = payload[tag];
        }
        return acc;
      }, {});
      url = constructURLFromUTMParams(url, utmParams);
    }
    // only root domain links can have empty desintation URL
  } else if (key !== "_root") {
    return {
      link: payload,
      error: "Missing destination URL",
      code: "bad_request",
    };
  }

  // free plan restrictions
  if (!workspace || workspace.plan === "free") {
    if (key === "_root" && url) {
      return {
        link: payload,
        error:
          "You can only set a redirect for a root domain link on a Pro plan and above. Upgrade to Pro to use this feature.",
        code: "forbidden",
      };
    }
    try {
      businessFeaturesCheck(payload);
      proFeaturesCheck(payload);
    } catch (error) {
      return {
        link: payload,
        error: error.message,
        code: "forbidden",
      };
    }
  } else if (workspace.plan === "pro") {
    try {
      businessFeaturesCheck(payload);
    } catch (error) {
      return {
        link: payload,
        error: error.message,
        code: "forbidden",
      };
    }
  }

  if (!trackConversion && testVariants) {
    return {
      link: payload,
      error: "Conversion tracking must be enabled to use A/B testing.",
      code: "unprocessable_entity",
    };
  }

  const domains = workspace
    ? await prisma.domain.findMany({
        where: { projectId: workspace.id },
      })
    : [];

  // if domain is not defined, set it to the workspace's primary domain
  if (!domain) {
    domain = domains?.find((d) => d.primary)?.slug || "dub.sh";
  }

  // checks for dub.sh and dub.link links
  if (domain === "dub.sh" || domain === "dub.link") {
    // for dub.link: check if workspace plan is pro+
    if (domain === "dub.link" && (!workspace || workspace.plan === "free")) {
      return {
        link: payload,
        error:
          "You can only use dub.link on a Pro plan and above. Upgrade to Pro to use this domain.",
        code: "forbidden",
      };
    }

    // for dub.sh: check if user exists (if userId is passed)
    if (domain === "dub.sh" && userId) {
      const userExists = await checkIfUserExists(userId);
      if (!userExists) {
        return {
          link: payload,
          error: "Session expired. Please log in again.",
          code: "not_found",
        };
      }
    }

    const isMaliciousLink = await maliciousLinkCheck(url);
    if (isMaliciousLink) {
      return {
        link: payload,
        error: "Malicious URL detected",
        code: "unprocessable_entity",
      };
    }
    // checks for other Dub-owned domains (chatg.pt, spti.fi, etc.)
  } else if (isDubDomain(domain)) {
    // coerce type with ! cause we already checked if it exists
    const { allowedHostnames } = DUB_DOMAINS.find((d) => d.slug === domain)!;
    const urlDomain = getDomainWithoutWWW(url) || "";
    const apexDomain = getApexDomain(url);
    if (
      key !== "_root" &&
      allowedHostnames &&
      !allowedHostnames.includes(urlDomain) &&
      !allowedHostnames.includes(apexDomain)
    ) {
      return {
        link: payload,
        error: `Invalid destination URL. You can only create ${domain} short links for URLs with the ${pluralize("domain", allowedHostnames.length)} ${allowedHostnames
          .map((d) => `"${d}"`)
          .join(", ")}.`,
        code: "unprocessable_entity",
      };
    }

    if (!skipKeyChecks && key?.includes("/")) {
      // check if the workspace has access to the parent link
      const parentKey = key.split("/")[0];
      const parentLink = await prisma.link.findUnique({
        where: { domain_key: { domain, key: parentKey } },
      });
      if (parentLink?.projectId !== workspace?.id) {
        return {
          link: payload,
          error: `You do not have access to create links in the ${domain}/${parentKey}/ subdirectory.`,
          code: "forbidden",
        };
      }
    }

    // else, check if the domain belongs to the workspace
  } else if (!domains?.find((d) => d.slug === domain)) {
    return {
      link: payload,
      error: "Domain does not belong to workspace.",
      code: "forbidden",
    };

    // else, check if the domain is a free .link and whether the workspace is pro+
  } else if (domain.endsWith(".link") && workspace?.plan === "free") {
    // Dub provisioned .link domains can only be used on a Pro plan and above
    const domainId = domains?.find((d) => d.slug === domain)?.id;
    const registeredDomain = await prisma.registeredDomain.findUnique({
      where: {
        domainId,
      },
    });
    if (registeredDomain) {
      return {
        link: payload,
        error:
          "You can only use your free .link domain on a Pro plan and above. Upgrade to Pro to use this domain.",
        code: "forbidden",
      };
    }
  }

  if (!key) {
    key = await getRandomKey({
      domain,
      prefix: payload["prefix"],
      length: keyLength,
    });
  } else if (!skipKeyChecks) {
    const processedKey = processKey({ domain, key });
    if (processedKey === null) {
      return {
        link: payload,
        error: "Invalid key.",
        code: "unprocessable_entity",
      };
    }
    key = processedKey;

    const response = await keyChecks({ domain, key, workspace });
    if (response.error && response.code) {
      return {
        link: payload,
        error: response.error,
        code: response.code,
      };
    }
  }

  if (externalId && workspace && !skipExternalIdChecks) {
    const link = await prisma.link.findUnique({
      where: {
        projectId_externalId: {
          projectId: workspace.id,
          externalId,
        },
      },
    });

    if (link) {
      return {
        link: payload,
        error: "A link with this externalId already exists in this workspace.",
        code: "conflict",
      };
    }
  }

  if (bulk) {
    if (proxy && image && isNotHostedImage(image)) {
      return {
        link: payload,
        error:
          "You cannot upload custom link preview images with bulk link creation.",
        code: "unprocessable_entity",
      };
    }
  } else {
    // only perform tag validity checks if:
    // - not bulk creation (we do that check separately in the route itself)
    // - tagIds are present
    if (tagIds && tagIds.length > 0) {
      if (!workspace) {
        return {
          link: payload,
          error:
            "Workspace not found. You can't add tags to a link without a workspace.",
          code: "not_found",
        };
      }
      const tags = await prisma.tag.findMany({
        select: {
          id: true,
        },
        where: { projectId: workspace.id, id: { in: tagIds } },
      });

      if (tags.length !== tagIds.length) {
        return {
          link: payload,
          error:
            "Invalid tagIds detected: " +
            tagIds
              .filter(
                (tagId) => tags.find(({ id }) => tagId === id) === undefined,
              )
              .join(", "),
          code: "unprocessable_entity",
        };
      }
    } else if (tagNames && tagNames.length > 0) {
      if (!workspace) {
        return {
          link: payload,
          error:
            "Workspace not found. You can't add tags to a link without a workspace.",
          code: "not_found",
        };
      }

      const tags = await prisma.tag.findMany({
        select: {
          name: true,
        },
        where: {
          projectId: workspace.id,
          name: { in: tagNames },
        },
      });

      if (tags.length !== tagNames.length) {
        return {
          link: payload,
          error:
            "Invalid tagNames detected: " +
            tagNames
              .filter(
                (tagName) =>
                  tags.find(({ name }) => tagName === name) === undefined,
              )
              .join(", "),
          code: "unprocessable_entity",
        };
      }
    }

    // only perform folder validity checks if:
    // - not bulk creation (we do that check separately in the route itself)
    // - folderId is present and we're not skipping folder checks
    if (folderId && !skipFolderChecks) {
      if (!workspace || !userId) {
        return {
          link: payload,
          error:
            "Workspace or user ID not found. You can't add a folder to a link without a workspace or user ID.",
          code: "not_found",
        };
      }

      if (workspace.plan === "free") {
        return {
          link: payload,
          error: "You can't add a folder to a link on a free plan.",
          code: "forbidden",
        };
      }

      try {
        await verifyFolderAccess({
          workspace,
          userId,
          folderId,
          requiredPermission: "folders.links.write",
        });
      } catch (error) {
        return {
          link: payload,
          error: error.message,
          code: error.code,
        };
      }
    }

    // Program validity checks
    if (programId && !skipProgramChecks) {
      const program = await prisma.program.findUnique({
        where: { id: programId },
        select: {
          workspaceId: true,
          defaultFolderId: true,
          ...(!partnerId && tenantId
            ? {
                partners: {
                  where: {
                    tenantId,
                  },
                },
              }
            : {}),
        },
      });

      if (!program || program.workspaceId !== workspace?.id) {
        return {
          link: payload,
          error: "Program not found.",
          code: "not_found",
        };
      }

      if (!partnerId) {
        partnerId =
          program?.partners?.length > 0 ? program.partners[0].partnerId : null;
      }

      defaultProgramFolderId = program.defaultFolderId;
    }

    // Webhook validity checks
    if (webhookIds && webhookIds.length > 0) {
      if (!workspace || workspace.plan === "free" || workspace.plan === "pro") {
        return {
          link: payload,
          error:
            "You can only use webhooks on a Business plan and above. Upgrade to Business to use this feature.",
          code: "forbidden",
        };
      }

      webhookIds = [...new Set(webhookIds)];

      const webhooks = await prisma.webhook.findMany({
        select: {
          id: true,
        },
        where: { projectId: workspace?.id, id: { in: webhookIds } },
      });

      if (webhooks.length !== webhookIds.length) {
        const invalidWebhookIds = webhookIds.filter(
          (webhookId) =>
            webhooks.find(({ id }) => webhookId === id) === undefined,
        );

        return {
          link: payload,
          error: "Invalid webhookIds detected: " + invalidWebhookIds.join(", "),
          code: "unprocessable_entity",
        };
      }
    }
  }

  // custom social media image checks (see if R2 is configured)
  if (proxy && !process.env.STORAGE_SECRET_ACCESS_KEY) {
    return {
      link: payload,
      error: "Missing storage access key.",
      code: "bad_request",
    };
  }

  // expire date checks
  if (expiresAt) {
    const datetime = parseDateTime(expiresAt);

    if (!datetime) {
      return {
        link: payload,
        error: "Invalid expiration date.",
        code: "unprocessable_entity",
      };
    }

    expiresAt = datetime;

    if (expiredUrl) {
      expiredUrl = getUrlFromString(expiredUrl);

      if (!isValidUrl(expiredUrl)) {
        return {
          link: payload,
          error: "Invalid expired URL.",
          code: "unprocessable_entity",
        };
      }
    }
  }

  if (testCompletedAt) {
    const datetime = parseDateTime(testCompletedAt);

    if (!datetime) {
      return {
        link: payload,
        error: "Invalid test completion date.",
        code: "unprocessable_entity",
      };
    }

    testCompletedAt = datetime;
  }

  // remove polyfill attributes from payload
  delete payload["shortLink"];
  delete payload["qrCode"];
  delete payload["keyLength"];
  delete payload["prefix"];
  UTMTags.forEach((tag) => {
    delete payload[tag];
  });

  return {
    link: {
      ...payload,
      domain,
      key,
      // we're redefining these fields because they're processed in the function
      url,
      expiresAt,
      expiredUrl,
      testVariants,
      testCompletedAt,
      // partnerId derived from payload or program enrollment
      partnerId: partnerId || null,
      // make sure projectId is set to the current workspace
      projectId: workspace?.id || null,
      // if userId is passed, set it (we don't change the userId if it's already set, e.g. when editing a link)
      ...(userId && {
        userId,
      }),
      ...(webhookIds && {
        webhookIds,
      }),
      folderId: folderId || defaultProgramFolderId,
    },
    error: null,
  };
}

async function maliciousLinkCheck(url: string) {
  const domain = getDomainWithoutWWW(url);

  if (!domain) {
    return false;
  }

  const domainBlacklisted = await isBlacklistedDomain(domain);
  if (domainBlacklisted === true) {
    return true;
  }

  return false;
}
