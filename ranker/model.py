"""The attention network that scores the 5 comments of a round.

    comment tokens [5] + post token [1] ── self-attention blocks (comments and post look at each other)
    comment tokens [5] ── cross-attention blocks ──> memory of earlier rounds (+ a learned "no memory" token)
    score = deep head on each comment + wide linear head on slot × person and style
    softmax over the 5 scores = the chance each comment is picked
"""
import torch
from torch import nn

from . import config
from .data import MEMORY_EXTRA, PLAIN_SIZE


class CrossBlock(nn.Module):
    """Pre-norm cross-attention (queries: comments, keys/values: memory) + feed-forward."""

    def __init__(self, d, heads, dropout):
        super().__init__()
        self.norm_q = nn.LayerNorm(d)
        self.norm_kv = nn.LayerNorm(d)
        self.attention = nn.MultiheadAttention(d, heads, dropout=dropout, batch_first=True)
        self.norm_ff = nn.LayerNorm(d)
        self.feed_forward = nn.Sequential(nn.Linear(d, 2 * d), nn.ReLU(), nn.Dropout(dropout), nn.Linear(2 * d, d))
        self.dropout = nn.Dropout(dropout)

    def forward(self, x, memory, mask):
        q = self.norm_q(x)
        kv = self.norm_kv(memory)
        attended, _ = self.attention(q, kv, kv, key_padding_mask=mask, need_weights=False)
        x = x + self.dropout(attended)
        return x + self.dropout(self.feed_forward(self.norm_ff(x)))


class CommentRanker(nn.Module):
    def __init__(self, people=0, d=32, heads=2, self_blocks=2, cross_blocks=2, dropout=0.3):
        super().__init__()
        embedding = config.EMBEDDING_DIM
        self.people = people
        self.comment_in = nn.Linear(embedding + PLAIN_SIZE, d)
        self.context_in = nn.Linear(embedding + 1, d)
        self.memory_in = nn.Linear(embedding + MEMORY_EXTRA, d)
        self.person = nn.Embedding(people + 1, d)
        self.no_memory = nn.Parameter(torch.zeros(1, 1, d))
        self.self_blocks = nn.ModuleList(
            nn.TransformerEncoderLayer(d, heads, 2 * d, dropout, batch_first=True, norm_first=True) for _ in range(self_blocks)
        )
        self.cross_blocks = nn.ModuleList(CrossBlock(d, heads, dropout) for _ in range(cross_blocks))
        self.head = nn.Sequential(nn.LayerNorm(d), nn.Linear(d, 1))
        # Wide head: style, plus a learned preference per slot for each person.
        self.wide = nn.Linear(PLAIN_SIZE + 5 * (people + 1), 1)

    def forward(self, comments, plain, context, memory, memory_mask, person):
        batch = comments.shape[0]
        tokens = self.comment_in(torch.cat([comments, plain], dim=-1)) + self.person(person)[:, None, :]
        post = self.context_in(context)[:, None, :]
        x = torch.cat([post, tokens], dim=1)
        for block in self.self_blocks:
            x = block(x)
        x = x[:, 1:]
        mem = torch.cat([self.no_memory.expand(batch, 1, -1), self.memory_in(memory)], dim=1)
        mask = torch.cat([torch.zeros(batch, 1, dtype=torch.bool, device=memory_mask.device), memory_mask], dim=1)
        for block in self.cross_blocks:
            x = block(x, mem, mask)
        deep = self.head(x).squeeze(-1)
        slot = plain[..., :5]
        person_one_hot = nn.functional.one_hot(person, self.people + 1).float()
        slot_by_person = (slot[..., :, None] * person_one_hot[:, None, None, :]).reshape(batch, 5, -1)
        wide = self.wide(torch.cat([plain, slot_by_person], dim=-1)).squeeze(-1)
        return deep + wide


def count_parameters(model):
    return sum(parameter.numel() for parameter in model.parameters())
