import { DomainStatusSchema } from "@/lib/zod/schemas/domains";
import { Domain } from "@dub/prisma/client";
import { describe, expect, onTestFinished, test } from "vitest";
import { z } from "zod";
import { randomId } from "../utils/helpers";
import { IntegrationHarness } from "../utils/integration";

const slug = `${randomId()}.dub-internal-test.com`;

const domainRecord = {
  slug: slug,
  expiredUrl: `https://${slug}/expired`,
  placeholder: `https://${slug}/placeholder`,
  notFoundUrl: `https://${slug}/not-found`,
};

const expectedDomain = {
  id: expect.any(String),
  slug: domainRecord.slug,
  verified: expect.any(Boolean),
  primary: expect.any(Boolean),
  archived: false,
  placeholder: domainRecord.placeholder,
  expiredUrl: domainRecord.expiredUrl,
  notFoundUrl: domainRecord.notFoundUrl,
  createdAt: expect.any(String),
  updatedAt: expect.any(String),
  registeredDomain: null,
  logo: null,
  appleAppSiteAssociation: null,
  assetLinks: null,
};

describe.sequential("/domains/**", async () => {
  const h = new IntegrationHarness();
  const { workspace, http } = await h.init();

  test("POST /domains", async () => {
    const { status, data: domain } = await http.post<Domain>({
      path: "/domains",
      query: { workspaceId: workspace.id },
      body: domainRecord,
    });

    expect(status).toEqual(201);
    expect(domain).toStrictEqual(expectedDomain);
  });

  test("GET /domains/{slug}", async () => {
    const { status, data: domain } = await http.get<Domain>({
      path: `/domains/${domainRecord.slug}`,
      query: { workspaceId: workspace.id },
    });

    expect(status).toEqual(200);
    expect(domain).toStrictEqual(expectedDomain);
  });

  test("GET /domains", async () => {
    const { status, data: domains } = await http.get<Domain[]>({
      path: "/domains",
      query: { workspaceId: workspace.id },
    });

    expect(status).toEqual(200);
    expect(
      domains.map((d) => ({ ...d, registeredDomain: null })),
    ).toContainEqual(expectedDomain);
  });

  test("POST /domains/{slug}/primary", { retry: 3 }, async () => {
    const { status, data: domain } = await http.post<Domain>({
      path: `/domains/${domainRecord.slug}/primary`,
      query: { workspaceId: workspace.id },
    });

    expect(status).toEqual(200);
    expect(domain).toStrictEqual({
      ...expectedDomain,
      primary: true,
    });

    onTestFinished(async () => {
      // reset the primary domain
      await http.post<Domain>({
        path: "/domains/getacme.link/primary",
        query: { workspaceId: workspace.id },
      });
    });
  });

  test("PATCH /domains/{slug}", { retry: 3 }, async () => {
    const toUpdate = {
      expiredUrl: `https://${slug}/expired-new`,
      placeholder: `https://${slug}/placeholder-new`,
      notFoundUrl: `https://${slug}/not-found-new`,
      archived: true,
    };

    onTestFinished(async () => {
      await h.deleteDomain(domainRecord.slug);
    });

    const { status, data: domain } = await http.patch<Domain>({
      path: `/domains/${domainRecord.slug}`,
      query: { workspaceId: workspace.id },
      body: toUpdate,
    });

    expect(status).toEqual(200);
    expect(domain).toStrictEqual({
      ...expectedDomain,
      ...toUpdate,
    });
  });

  test("GET /domains/status", async () => {
    const domains = [
      "getacme.link", // expected to be unavailable
      `acme-${randomId(4).toLowerCase()}.link`, // expected to be available
    ];

    const { status, data: domainStatuses } = await http.get<
      z.infer<typeof DomainStatusSchema>[]
    >({
      path: "/domains/status",
      query: {
        workspaceId: workspace.id,
        domains: domains.join(","),
      },
    });

    expect(status).toEqual(200);
    expect(domainStatuses).toHaveLength(2);
    expect(domainStatuses).toEqual([
      {
        domain: domains[0],
        available: false,
        price: null,
        premium: null,
      },
      {
        domain: domains[1],
        available: true,
        price: expect.any(String),
        premium: expect.any(Boolean),
      },
    ]);
  });
});
