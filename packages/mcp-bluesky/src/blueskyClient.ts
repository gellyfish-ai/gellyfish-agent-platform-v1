import { BskyAgent, RichText } from '@atproto/api';

export interface PostRef {
  uri: string;
  cid: string;
}

export interface ImageInput {
  data: Buffer;
  encoding: string;
}

export class BlueskyClient {
  private agent: BskyAgent;
  private isAuthenticated = false;

  constructor() {
    const service = process.env.BLUESKY_SERVICE || 'https://bsky.social';
    this.agent = new BskyAgent({ service });
  }

  async autoLogin(): Promise<void> {
    const identifier = process.env.BLUESKY_IDENTIFIER;
    const password = process.env.BLUESKY_PASSWORD || process.env.BLUESKY_APP_PASSWORD;
    if (!identifier || !password) {
      throw new Error('BLUESKY_IDENTIFIER and BLUESKY_PASSWORD (or BLUESKY_APP_PASSWORD) must be set');
    }
    await this.login(identifier, password);
  }

  async login(identifier: string, password: string): Promise<void> {
    await this.agent.login({ identifier, password });
    this.isAuthenticated = true;
    console.error('Successfully logged in to Bluesky');
  }

  private ensureAuth(): void {
    if (!this.isAuthenticated) throw new Error('Not authenticated. Please login first.');
  }

  async createPost(text: string, images?: ImageInput[], replyTo?: PostRef, rootPost?: PostRef): Promise<PostRef> {
    this.ensureAuth();

    const rt = new RichText({ text });
    await rt.detectFacets(this.agent);

    const postRecord: Record<string, unknown> = {
      text: rt.text,
      facets: rt.facets,
      createdAt: new Date().toISOString(),
    };

    // Threading: add reply field if replyTo is provided
    if (replyTo) {
      postRecord.reply = {
        root: { uri: (rootPost || replyTo).uri, cid: (rootPost || replyTo).cid },
        parent: { uri: replyTo.uri, cid: replyTo.cid },
      };
    }

    if (images && images.length > 0) {
      const uploadedImages = [];
      for (const image of images) {
        const response = await this.agent.uploadBlob(image.data, { encoding: image.encoding });
        if (response.success) {
          uploadedImages.push(response.data.blob);
        }
      }
      if (uploadedImages.length > 0) {
        postRecord.embed = {
          $type: 'app.bsky.embed.images',
          images: uploadedImages.map((blob) => ({ alt: 'Image', image: blob })),
        };
      }
    }

    const response = await this.agent.post(postRecord);
    console.error('Successfully created post:', response.uri);
    return { uri: response.uri, cid: response.cid };
  }

  async createThread(texts: string[], images?: ImageInput[]): Promise<PostRef[]> {
    this.ensureAuth();
    if (texts.length === 0) throw new Error('Thread must have at least one post');

    const results: PostRef[] = [];

    // First post (with optional images)
    const first = await this.createPost(texts[0], images);
    results.push(first);

    // Chain subsequent posts as replies
    const root = first;
    let parent = first;
    for (let i = 1; i < texts.length; i++) {
      const reply = await this.createPost(texts[i], undefined, parent, root);
      results.push(reply);
      parent = reply;
    }

    return results;
  }

  async getProfile() {
    this.ensureAuth();
    return this.agent.getProfile({ actor: this.agent.session?.did || '' });
  }

  async getTimeline(limit = 20) {
    this.ensureAuth();
    return this.agent.getTimeline({ limit });
  }

  async getAuthorFeed(actor: string, limit = 20) {
    this.ensureAuth();
    return this.agent.getAuthorFeed({ actor, limit });
  }

  async getPost(postUri: string) {
    this.ensureAuth();
    return this.agent.getPostThread({ uri: postUri });
  }

  async getPosts(uris: string[]) {
    this.ensureAuth();
    return this.agent.getPosts({ uris });
  }

  async deletePost(postUri: string): Promise<void> {
    this.ensureAuth();
    await this.agent.deletePost(postUri);
  }

  async likePost(uri: string, cid: string) {
    this.ensureAuth();
    return this.agent.like(uri, cid);
  }

  async unlikePost(likeUri: string): Promise<void> {
    this.ensureAuth();
    await this.agent.deleteLike(likeUri);
  }

  async repostPost(uri: string, cid: string) {
    this.ensureAuth();
    return this.agent.repost(uri, cid);
  }

  async unrepostPost(repostUri: string): Promise<void> {
    this.ensureAuth();
    await this.agent.deleteRepost(repostUri);
  }

  isLoggedIn(): boolean {
    return this.isAuthenticated;
  }
}
