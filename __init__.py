from typing_extensions import override
from comfy_api.latest import ComfyExtension, io

from .magik_waifudb import WaifuDBNode

WEB_DIRECTORY = "./js"


class MagikWaifuDBExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [WaifuDBNode]


async def comfy_entrypoint() -> MagikWaifuDBExtension:
    return MagikWaifuDBExtension()
