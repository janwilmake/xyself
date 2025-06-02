// @ts-check
/// <reference types="@cloudflare/workers-types" />
/// <reference lib="esnext" />
// Import the OAuth middleware (assuming it's available as a module or copied)
import {
  handleOAuth,
  getCurrentUser,
  getAccessToken,
  type Env as OAuthEnv,
} from "smootherauth-github";

// Extend the Env interface to include KV binding
export interface Env extends OAuthEnv {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  USER_DATA: KVNamespace; // Add your KV binding here
}

interface UserData {
  x_username?: string | null;
  bio?: string | null;
  context?: string;
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    // Handle OPTIONS request for CORS
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // Handle OAuth routes first
    const oauthResponse = await handleOAuth(request, env, "user:email");
    if (oauthResponse) {
      return oauthResponse;
    }

    // Root path - show usage
    if (path === "/") {
      const user = getCurrentUser(request);
      const usage = {
        description: "GitHub to X Username Lookup API with OAuth",
        authenticated_user: user
          ? {
              username: user.login,
              avatar: user.avatar_url,
            }
          : null,
        auth: {
          login: `${url.origin}/login`,
          logout: `${url.origin}/logout`,
        },
        usage: {
          get_profile: {
            endpoint: "GET /{username}",
            example: `${url.origin}/octocat`,
            description: "Get user profile (merges authorized and public data)",
          },
          set_authorized: {
            endpoint: "POST /{username}/set",
            description: "Set your own profile data (requires GitHub auth)",
            auth_required: true,
            body: {
              x_username: "string|null",
              bio: "string|null",
              context: "string",
            },
          },
          set_public: {
            endpoint: "POST /{username}/set",
            description: "Set any user's public profile data",
            auth_required: false,
            body: {
              x_username: "string|null",
              bio: "string|null",
              context: "string",
            },
          },
        },
      };

      return new Response(JSON.stringify(usage, null, 2), {
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
      });
    }

    // Parse username from path
    const pathMatch = path.match(/^\/([^\/]+)(?:\/(.+))?$/);
    if (!pathMatch) {
      return new Response(JSON.stringify({ error: "Invalid path format" }), {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
      });
    }

    const [, username, action] = pathMatch;

    if (!username) {
      return new Response(JSON.stringify({ error: "Username is required" }), {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
      });
    }

    // Handle POST /{username}/set
    if (action === "set" && request.method === "POST") {
      return handleSetUserData(request, env, username, corsHeaders);
    }

    // Handle GET /{username}
    if (!action && request.method === "GET") {
      return handleGetUserProfile(request, env, username, corsHeaders);
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders,
      },
    });
  },
};

async function handleSetUserData(
  request: Request,
  env: Env,
  username: string,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  try {
    const body = (await request.json()) as UserData;

    // Validate body structure
    if (typeof body !== "object" || body === null) {
      return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
        status: 400,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
      });
    }

    // Check if user is authenticated and if they're setting their own data
    const currentUser = getCurrentUser(request);
    const isAuthorized = currentUser && currentUser.login === username;

    let key: string;
    let keyType: string;

    if (isAuthorized) {
      // User is authenticated and setting their own data
      key = `authorized:${username}`;
      keyType = "authorized";
    } else {
      // Public data (anyone can set)
      key = `public:${username}`;
      keyType = "public";
    }

    // Store in KV
    await env.USER_DATA.put(key, JSON.stringify(body));

    return new Response(
      JSON.stringify({
        success: true,
        message: `${keyType} data updated for ${username}`,
        data: body,
        key_type: keyType,
      }),
      {
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
      },
    );
  } catch (error) {
    console.error("Error setting user data:", error);
    return new Response(
      JSON.stringify({
        error: "Failed to set user data",
        details: error instanceof Error ? error.message : "Unknown error",
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
      },
    );
  }
}

async function handleGetUserProfile(
  request: Request,
  env: Env,
  username: string,
  corsHeaders: Record<string, string>,
): Promise<Response> {
  try {
    // Fetch from GitHub API first (fallback data)
    let githubData: any = null;
    let githubError: string | null = null;

    try {
      const githubResponse = await fetch(
        `https://api.github.com/users/${username}`,
        {
          headers: {
            "User-Agent": "Cloudflare-Worker",
          },
        },
      );

      if (githubResponse.ok) {
        githubData = await githubResponse.json();
      } else if (githubResponse.status === 404) {
        githubError = "GitHub user not found";
      } else {
        githubError = `GitHub API error: ${githubResponse.status}`;
      }
    } catch (error) {
      console.error("GitHub API error:", error);
      githubError = "Failed to fetch from GitHub";
    }

    // Get stored data from KV
    const [authorizedData, publicData] = await Promise.all([
      env.USER_DATA.get(
        `authorized:${username}`,
        "json",
      ) as Promise<UserData | null>,
      env.USER_DATA.get(
        `public:${username}`,
        "json",
      ) as Promise<UserData | null>,
    ]);

    // Start with GitHub data as base
    let result: any = {
      github_username: username,
      x_username: null,
      profile_picture: null,
      bio: null,
      context: "",
    };

    // If we have GitHub data, use it as base
    if (githubData) {
      result.github_username = githubData.login;
      result.profile_picture = githubData.avatar_url;
      result.bio = githubData.bio || null;

      // Extract X username from GitHub data
      if (githubData.twitter_username) {
        result.x_username = githubData.twitter_username;
      } else if (githubData.blog) {
        const blogUrl = githubData.blog.toLowerCase();
        const twitterMatch = blogUrl.match(
          /(?:twitter\.com|x\.com)\/([a-zA-Z0-9_]+)/,
        );
        if (twitterMatch) {
          result.x_username = twitterMatch[1];
        }
      }

      // Build default context
      const contextParts = [];
      if (result.x_username) {
        contextParts.push(`https://xymake.com/${result.x_username}.md`);
      }
      contextParts.push(`https://flaredream.com/${githubData.login}`);
      result.context = contextParts.join("\n");
    }

    // Merge with public data if available
    if (publicData) {
      if (publicData.x_username !== undefined)
        result.x_username = publicData.x_username;
      if (publicData.bio !== undefined) result.bio = publicData.bio;
      if (publicData.context !== undefined) result.context = publicData.context;
    }

    // Merge with authorized data if available (highest priority)
    if (authorizedData) {
      if (authorizedData.x_username !== undefined)
        result.x_username = authorizedData.x_username;
      if (authorizedData.bio !== undefined) result.bio = authorizedData.bio;
      if (authorizedData.context !== undefined)
        result.context = authorizedData.context;
    }

    // Add metadata about data sources
    result._metadata = {
      sources: {
        github: !!githubData,
        public_override: !!publicData,
        authorized_override: !!authorizedData,
      },
      github_error: githubError,
    };

    return new Response(JSON.stringify(result, null, 2), {
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders,
      },
    });
  } catch (error) {
    console.error("Error fetching user profile:", error);

    return new Response(
      JSON.stringify({
        error: "Failed to fetch user profile",
        details: error instanceof Error ? error.message : "Unknown error",
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
          ...corsHeaders,
        },
      },
    );
  }
}
