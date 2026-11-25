#!/usr/bin/env python3
"""
Generate a synthetic Nsight Systems SQLite export for demos and testing.

The tables and columns mirror what `nsys export --type sqlite` produces
(StringIds, CUPTI_ACTIVITY_KIND_*, NVTX_EVENTS, OSRT_API, ThreadNames, ...),
so the viewer exercises the same code paths as with a real profile.

The workload imitates a 2-rank PyTorch DDP training loop on two GPUs:
NVTX ranges per step, kernel launches from the main and autograd threads,
NCCL all-reduce on a separate stream, H2D/D2H copies, memsets, OS runtime
calls and GPU metrics samples.

Usage:
    python3 scripts/make_sample.py --out public/sample.sqlite
    python3 scripts/make_sample.py --out /tmp/big.sqlite --steps 400 --layers 48
"""
import argparse
import os
import random
import sqlite3

US = 1_000
MS = 1_000_000

SCHEMA = """
CREATE TABLE StringIds (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE META_DATA_EXPORT (name TEXT, value TEXT);
CREATE TABLE META_DATA_CAPTURE (name TEXT, value TEXT);
CREATE TABLE ANALYSIS_DETAILS (globalVid INTEGER, duration INTEGER NOT NULL, startTime INTEGER NOT NULL, stopTime INTEGER NOT NULL);
CREATE TABLE TARGET_INFO_SESSION_START_TIME (utcEpochNs INTEGER, utcTime TEXT, localTime TEXT);
CREATE TABLE TARGET_INFO_SYSTEM_ENV (globalVid INTEGER, devStateName TEXT NOT NULL, name TEXT NOT NULL, nameEnum INTEGER NOT NULL, value TEXT NOT NULL);
CREATE TABLE TARGET_INFO_GPU (vmId INTEGER NOT NULL, id INTEGER NOT NULL, name TEXT, busLocation TEXT, isDiscrete INTEGER, l2CacheSize INTEGER, totalMemory INTEGER, memoryBandwidth INTEGER, clockRate INTEGER, smCount INTEGER, pwGpuId INTEGER, uuid TEXT, luid INTEGER, chipName TEXT);
CREATE TABLE TARGET_INFO_CUDA_DEVICE (gpuId INTEGER, cudaId INTEGER, pid INTEGER, uuid TEXT, numMultiprocessors INTEGER, computeMajor INTEGER, computeMinor INTEGER, maxWarpsPerMultiprocessor INTEGER, maxBlocksPerMultiprocessor INTEGER, maxRegistersPerBlock INTEGER, maxSharedMemoryPerBlock INTEGER, name TEXT);
CREATE TABLE TARGET_INFO_CUDA_STREAM (streamId INTEGER NOT NULL, hwId INTEGER NOT NULL, vmId INTEGER NOT NULL, processId INTEGER NOT NULL, contextId INTEGER NOT NULL, priority INTEGER NOT NULL, flag INTEGER NOT NULL);
CREATE TABLE PROCESSES (globalPid INTEGER, pid INTEGER, name TEXT);
CREATE TABLE ThreadNames (nameId INTEGER NOT NULL REFERENCES StringIds(id), priority INTEGER, globalTid INTEGER);
CREATE TABLE ENUM_CUDA_MEMCPY_OPER (id INTEGER PRIMARY KEY, name TEXT, label TEXT);
CREATE TABLE ENUM_CUDA_MEM_KIND (id INTEGER PRIMARY KEY, name TEXT, label TEXT);
CREATE TABLE ENUM_NSYS_EVENT_TYPE (id INTEGER PRIMARY KEY, name TEXT, label TEXT);
CREATE TABLE CUPTI_ACTIVITY_KIND_KERNEL (start INTEGER NOT NULL, end INTEGER NOT NULL, deviceId INTEGER NOT NULL, contextId INTEGER NOT NULL, greenContextId INTEGER, streamId INTEGER NOT NULL, correlationId INTEGER, globalPid INTEGER, demangledName INTEGER NOT NULL REFERENCES StringIds(id), shortName INTEGER NOT NULL REFERENCES StringIds(id), mangledName INTEGER REFERENCES StringIds(id), launchType INTEGER, cacheConfig INTEGER, registersPerThread INTEGER NOT NULL, gridX INTEGER NOT NULL, gridY INTEGER NOT NULL, gridZ INTEGER NOT NULL, blockX INTEGER NOT NULL, blockY INTEGER NOT NULL, blockZ INTEGER NOT NULL, staticSharedMemory INTEGER NOT NULL, dynamicSharedMemory INTEGER NOT NULL, localMemoryPerThread INTEGER NOT NULL, localMemoryTotal INTEGER NOT NULL, gridId INTEGER NOT NULL, sharedMemoryExecuted INTEGER, graphNodeId INTEGER, sharedMemoryLimitConfig INTEGER);
CREATE TABLE CUPTI_ACTIVITY_KIND_MEMCPY (start INTEGER NOT NULL, end INTEGER NOT NULL, deviceId INTEGER NOT NULL, contextId INTEGER NOT NULL, greenContextId INTEGER, streamId INTEGER NOT NULL, correlationId INTEGER, globalPid INTEGER, bytes INTEGER NOT NULL, copyKind INTEGER NOT NULL, deprecatedSrcId INTEGER, srcKind INTEGER, dstKind INTEGER, srcDeviceId INTEGER, srcContextId INTEGER, dstDeviceId INTEGER, dstContextId INTEGER, migrationCause INTEGER, graphNodeId INTEGER, virtualAddress INTEGER);
CREATE TABLE CUPTI_ACTIVITY_KIND_MEMSET (start INTEGER NOT NULL, end INTEGER NOT NULL, deviceId INTEGER NOT NULL, contextId INTEGER NOT NULL, greenContextId INTEGER, streamId INTEGER NOT NULL, correlationId INTEGER, globalPid INTEGER, value INTEGER NOT NULL, bytes INTEGER NOT NULL, graphNodeId INTEGER, memKind INTEGER);
CREATE TABLE CUPTI_ACTIVITY_KIND_RUNTIME (start INTEGER NOT NULL, end INTEGER NOT NULL, eventClass INTEGER NOT NULL, globalTid INTEGER, correlationId INTEGER, nameId INTEGER NOT NULL REFERENCES StringIds(id), returnValue INTEGER NOT NULL, callchainId INTEGER);
CREATE TABLE NVTX_EVENTS (start INTEGER NOT NULL, end INTEGER, eventType INTEGER NOT NULL, rangeId INTEGER, category INTEGER, color INTEGER, text TEXT, globalTid INTEGER, endGlobalTid INTEGER, textId INTEGER REFERENCES StringIds(id), domainId INTEGER, uint64Value INTEGER, int64Value INTEGER, doubleValue REAL, uint32Value INTEGER, int32Value INTEGER, floatValue REAL, jsonTextId INTEGER, jsonText TEXT);
CREATE TABLE OSRT_API (start INTEGER NOT NULL, end INTEGER NOT NULL, eventClass INTEGER NOT NULL, globalTid INTEGER, correlationId INTEGER, nameId INTEGER NOT NULL REFERENCES StringIds(id), returnValue INTEGER NOT NULL, nestingLevel INTEGER, callchainId INTEGER);
CREATE TABLE CUBLAS_EVENTS (start INTEGER NOT NULL, end INTEGER NOT NULL, eventClass INTEGER NOT NULL, globalTid INTEGER, nameId INTEGER NOT NULL REFERENCES StringIds(id));
CREATE TABLE PROFILER_OVERHEAD (start INTEGER NOT NULL, end INTEGER NOT NULL, globalTid INTEGER, correlationId INTEGER, nameId INTEGER NOT NULL REFERENCES StringIds(id));
CREATE TABLE TARGET_INFO_GPU_METRICS (typeId INTEGER NOT NULL, sourceId INTEGER NOT NULL, typeName TEXT NOT NULL, metricId INTEGER NOT NULL, metricName TEXT NOT NULL);
CREATE TABLE GPU_METRICS (typeId INTEGER NOT NULL, timestamp INTEGER, metricId INTEGER NOT NULL, value INTEGER NOT NULL);
"""

MEMCPY_KINDS = [
    (0, "CUDA_MEMCPY_KIND_UNKNOWN", "Unknown"),
    (1, "CUDA_MEMCPY_KIND_HTOD", "Host-to-Device"),
    (2, "CUDA_MEMCPY_KIND_DTOH", "Device-to-Host"),
    (3, "CUDA_MEMCPY_KIND_HTOA", "Host-to-Array"),
    (4, "CUDA_MEMCPY_KIND_ATOH", "Array-to-Host"),
    (5, "CUDA_MEMCPY_KIND_ATOA", "Array-to-Array"),
    (6, "CUDA_MEMCPY_KIND_ATOD", "Array-to-Device"),
    (7, "CUDA_MEMCPY_KIND_DTOA", "Device-to-Array"),
    (8, "CUDA_MEMCPY_KIND_DTOD", "Device-to-Device"),
    (9, "CUDA_MEMCPY_KIND_HTOH", "Host-to-Host"),
    (10, "CUDA_MEMCPY_KIND_PTOP", "Peer-to-Peer"),
]
MEM_KINDS = [
    (0, "CUDA_MEMORY_KIND_UNKNOWN", "Unknown"),
    (1, "CUDA_MEMORY_KIND_PAGEABLE", "Pageable"),
    (2, "CUDA_MEMORY_KIND_PINNED", "Pinned"),
    (3, "CUDA_MEMORY_KIND_DEVICE", "Device"),
    (4, "CUDA_MEMORY_KIND_ARRAY", "Array"),
    (5, "CUDA_MEMORY_KIND_MANAGED", "Managed"),
]

# (shortName, demangledName template, typical duration us, grid, block, regs)
KERNELS = {
    "gemm": ("sm90_xmma_gemm_bf16bf16_bf16f32_f32_tn_n_tilesize128x128x64_warpgroupsize1x1x1_execute_segment_k_off_kernel__5x_cublas",
             "sm90_xmma_gemm_bf16bf16_bf16f32_f32_tn_n_tilesize128x128x64_warpgroupsize1x1x1_execute_segment_k_off_kernel__5x_cublas",
             260, (132, 1, 1), (384, 1, 1), 168),
    "gemm_bwd": ("sm90_xmma_gemm_bf16bf16_bf16f32_f32_nn_n_tilesize128x256x64_warpgroupsize2x1x1_execute_segment_k_off_kernel__5x_cublas",
                 "sm90_xmma_gemm_bf16bf16_bf16f32_f32_nn_n_tilesize128x256x64_warpgroupsize2x1x1_execute_segment_k_off_kernel__5x_cublas",
                 420, (132, 1, 1), (384, 1, 1), 168),
    "flash_fwd": ("flash_fwd_kernel",
                  "void flash::flash_fwd_kernel<Flash_fwd_kernel_traits<128, 128, 64, 4, false, false, cutlass::bfloat16_t>, true, false, false, false, true, true, false>(flash::Flash_fwd_params)",
                  310, (16, 32, 8), (128, 1, 1), 255),
    "flash_bwd": ("flash_bwd_dq_dk_dv_loop_seqk_parallel_kernel",
                  "void flash::flash_bwd_dq_dk_dv_loop_seqk_parallel_kernel<Flash_bwd_kernel_traits<128, 64, 128, 8, 2, 4, 2, false, false, cutlass::bfloat16_t>, true, false, false, false, true, true>(flash::Flash_bwd_params)",
                  690, (16, 32, 8), (256, 1, 1), 255),
    "layer_norm": ("vectorized_layer_norm_kernel",
                   "void at::native::(anonymous namespace)::vectorized_layer_norm_kernel<c10::BFloat16, float>(int, float, c10::BFloat16 const*, c10::BFloat16 const*, c10::BFloat16 const*, float*, float*, c10::BFloat16*)",
                   38, (4096, 1, 1), (32, 4, 1), 40),
    "layer_norm_bwd": ("layer_norm_grad_input_kernel",
                       "void at::native::(anonymous namespace)::layer_norm_grad_input_kernel_vectorized<c10::BFloat16, float>(c10::BFloat16 const*, c10::BFloat16 const*, float const*, float const*, c10::BFloat16 const*, c10::BFloat16*, int)",
                       52, (4096, 1, 1), (128, 1, 1), 48),
    "gelu": ("vectorized_elementwise_kernel",
             "void at::native::vectorized_elementwise_kernel<4, at::native::GeluCUDAKernelImpl(at::TensorIteratorBase&, at::native::GeluType)::{lambda()#2}::operator()() const::{lambda()#4}::operator()() const::{lambda(c10::BFloat16)#1}, at::detail::Array<char*, 2> >(int, at::native::GeluCUDAKernelImpl(at::TensorIteratorBase&, at::native::GeluType)::{lambda()#2}::operator()() const::{lambda()#4}::operator()() const::{lambda(c10::BFloat16)#1}, at::detail::Array<char*, 2>)",
             44, (8192, 1, 1), (128, 1, 1), 26),
    "add": ("vectorized_elementwise_kernel",
            "void at::native::vectorized_elementwise_kernel<4, at::native::CUDAFunctor_add<c10::BFloat16>, at::detail::Array<char*, 3> >(int, at::native::CUDAFunctor_add<c10::BFloat16>, at::detail::Array<char*, 3>)",
            21, (8192, 1, 1), (128, 1, 1), 22),
    "softmax_ce": ("cunn_SoftMaxForward",
                   "void (anonymous namespace)::cunn_SoftMaxForward<8, c10::BFloat16, float, c10::BFloat16, (anonymous namespace)::LogSoftMaxForwardEpilogue>(c10::BFloat16*, c10::BFloat16 const*, int)",
                   140, (8192, 1, 1), (1024, 1, 1), 32),
    "reduce": ("reduce_kernel",
               "void at::native::reduce_kernel<512, 1, at::native::ReduceOp<float, at::native::func_wrapper_t<float, at::native::sum_functor<float, float, float>::operator()(at::TensorIterator&)::{lambda(float, float)#1}>, unsigned int, float, 4> >(at::native::ReduceOp<float, at::native::func_wrapper_t<float, at::native::sum_functor<float, float, float>::operator()(at::TensorIterator&)::{lambda(float, float)#1}>, unsigned int, float, 4>)",
               18, (132, 1, 1), (512, 1, 1), 36),
    "nccl": ("ncclDevKernel_AllReduce_Sum_bf16_RING_LL",
             "ncclDevKernel_AllReduce_Sum_bf16_RING_LL(ncclDevKernelArgsStorage<4096ul>)",
             2600, (24, 1, 1), (640, 1, 1), 96),
    "adam": ("multi_tensor_apply_kernel",
             "void at::native::(anonymous namespace)::multi_tensor_apply_kernel<at::native::(anonymous namespace)::TensorListMetadata<4>, at::native::(anonymous namespace)::FusedAdamMathFunctor<float, 4, (at::native::ADAM_MODE)1, false>, float*, double, double, double, double, double, double, bool, float*, float*>(at::native::(anonymous namespace)::TensorListMetadata<4>, at::native::(anonymous namespace)::FusedAdamMathFunctor<float, 4, (at::native::ADAM_MODE)1, false>, float*, double, double, double, double, double, double, bool, float*, float*)",
             160, (320, 1, 1), (512, 1, 1), 72),
    "embedding": ("indexSelectLargeIndex",
                  "void at::native::indexSelectLargeIndex<c10::BFloat16, long, unsigned int, 2, 2, -2, true>(at::cuda::detail::TensorInfo<c10::BFloat16, unsigned int>, at::cuda::detail::TensorInfo<c10::BFloat16 const, unsigned int>, at::cuda::detail::TensorInfo<long const, unsigned int>, int, int, unsigned int, unsigned int, long)",
                  66, (4096, 1, 1), (128, 1, 1), 30),
}


def argb(r, g, b):
    return (0xFF << 24) | (r << 16) | (g << 8) | b


NVTX_COLORS = {
    "train_step": argb(0x76, 0xB9, 0x00),
    "data_loading": argb(0x3B, 0x82, 0xF6),
    "forward": argb(0xF5, 0x9E, 0x0B),
    "backward": argb(0xEF, 0x44, 0x44),
    "optimizer_step": argb(0xA8, 0x55, 0xF7),
    "allreduce": argb(0x06, 0xB6, 0xD4),
}


class Gen:
    def __init__(self, seed, steps, layers):
        self.rng = random.Random(seed)
        self.steps = steps
        self.layers = layers
        self.strings = {}
        self.rows = {k: [] for k in (
            "kernel", "memcpy", "memset", "runtime", "nvtx", "osrt", "cublas", "overhead", "metrics")}
        self.corr = 1000
        self.stream_free = {}

    def sid(self, s):
        if s not in self.strings:
            self.strings[s] = len(self.strings)
        return self.strings[s]

    def jitter(self, us, spread=0.15):
        return max(1, int(us * US * self.rng.uniform(1 - spread, 1 + spread)))

    def next_corr(self):
        self.corr += 1
        return self.corr

    # --- CPU-side helpers -------------------------------------------------
    def api(self, gtid, name, t, dur_ns, corr=None):
        self.rows["runtime"].append((t, t + dur_ns, 1, gtid, corr, self.sid(name), 0, None))
        return t + dur_ns

    def osrt(self, gtid, name, t, dur_ns, level=0):
        self.rows["osrt"].append((t, t + dur_ns, 27, gtid, None, self.sid(name), 0, level, None))
        return t + dur_ns

    def nvtx_range(self, gtid, text, t0, t1, domain=0, color=None, category=None):
        self.rows["nvtx"].append((t0, t1, 59, None, category, color, None, gtid, None,
                                  self.sid(text), domain, None, None, None, None, None, None, None, None))

    def nvtx_mark(self, gtid, text, t, domain=0):
        self.rows["nvtx"].append((t, None, 34, None, None, None, text, gtid, None,
                                  None, domain, None, None, None, None, None, None, None, None))

    # --- GPU-side helpers -------------------------------------------------
    def gpu_start(self, dev, stream, t_ready):
        key = (dev, stream)
        return max(t_ready, self.stream_free.get(key, 0))

    def launch(self, proc, gtid, t, kind, stream, scale=1.0):
        """cudaLaunchKernel on the CPU + kernel execution on the GPU."""
        short, demangled, dur_us, grid, block, regs = KERNELS[kind]
        corr = self.next_corr()
        api_dur = self.jitter(4.2, 0.4)
        t_end = self.api(gtid, "cudaLaunchKernel", t, api_dur, corr)
        if kind.startswith("gemm") and self.rng.random() < 0.6:
            self.rows["cublas"].append((t - self.jitter(1.5), t_end + self.jitter(0.8), 0, gtid,
                                        self.sid("cublasGemmEx")))
        dev = proc["dev"]
        start = self.gpu_start(dev, stream, t + self.jitter(3.5, 0.5))
        dur = self.jitter(dur_us * scale, 0.12)
        end = start + dur
        self.stream_free[(dev, stream)] = end
        self.rows["kernel"].append((
            start, end, dev, 1, None, stream, corr, proc["gpid"],
            self.sid(demangled), self.sid(short), self.sid("_Z" + short), 0, 0, regs,
            grid[0], grid[1], grid[2], block[0], block[1], block[2],
            0 if "flash" not in kind else 0, 49152 if "gemm" in kind or "flash" in kind else 0,
            0, 0, self.next_corr() * 3, 65536 if "gemm" in kind else 0, None, 1))
        return t_end

    def memcpy(self, proc, gtid, t, kind, nbytes, stream, api_name="cudaMemcpyAsync", src_kind=2, dst_kind=3):
        corr = self.next_corr()
        api_dur = self.jitter(6.0, 0.3)
        dev = proc["dev"]
        bw = {1: 24e9, 2: 22e9, 8: 1400e9, 10: 300e9}.get(kind, 20e9)  # bytes per second
        start = self.gpu_start(dev, stream, t + self.jitter(4))
        dur = max(1200, int(nbytes / bw * 1e9 * self.rng.uniform(0.9, 1.1)))
        end = start + dur
        self.stream_free[(dev, stream)] = end
        if api_name == "cudaMemcpy":  # synchronous: API blocks until the copy is done
            api_dur = end - t + self.jitter(2)
        t_end = self.api(gtid, api_name, t, api_dur, corr)
        self.rows["memcpy"].append((start, end, dev, 1, None, stream, corr, proc["gpid"], nbytes, kind, None,
                                    src_kind, dst_kind, dev, 1, dev, 1, None, None, None))
        return t_end

    def memset(self, proc, gtid, t, nbytes, stream):
        corr = self.next_corr()
        t_end = self.api(gtid, "cudaMemsetAsync", t, self.jitter(3.0), corr)
        dev = proc["dev"]
        start = self.gpu_start(dev, stream, t + self.jitter(3))
        end = start + max(1500, int(nbytes / 1800e9 * 1e9))
        self.stream_free[(dev, stream)] = end
        self.rows["memset"].append((start, end, dev, 1, None, stream, corr, proc["gpid"], 0, nbytes, None, 3))
        return t_end

    def sync(self, proc, gtid, t, stream, name="cudaStreamSynchronize"):
        corr = self.next_corr()
        done = self.stream_free.get((proc["dev"], stream), t)
        end = max(t + self.jitter(2), done + self.jitter(3))
        self.api(gtid, name, t, end - t, corr)
        return end

    # --- workload --------------------------------------------------------
    def build(self):
        rng = self.rng
        procs = []
        for rank in range(2):
            pid = 48213 + rank * 7
            gpid = (1 << 48) | (pid << 24)
            procs.append({
                "rank": rank, "pid": pid, "gpid": gpid, "dev": rank,
                "main": gpid | pid,
                "autograd": gpid | (pid + 1),
                "loader": [gpid | (pid + 2 + i) for i in range(2)],
                "evt": gpid | (pid + 5),
                "nccl": gpid | (pid + 6),
            })
        self.procs = procs

        t_begin = 412 * MS  # the app spends time importing before CUDA work starts
        last_end = 0
        for p in procs:
            t = t_begin + p["rank"] * self.jitter(900)
            g = p["main"]
            # Startup: context creation and allocations
            t = self.api(g, "cudaGetDeviceCount", t, self.jitter(30))
            t = self.api(g, "cudaSetDevice", t, self.jitter(12))
            t = self.api(g, "cuCtxCreate_v2", t, self.jitter(180_000))
            for _ in range(24):
                t = self.api(g, "cudaMalloc", t, self.jitter(rng.choice([18, 22, 240, 1200])))
            t = self.memcpy(p, g, t, 1, 512 * 1024 * 1024, 7, "cudaMemcpy", 1, 3)  # load weights
            self.nvtx_mark(g, "model ready", t)
            t += self.jitter(3000)

            for step in range(self.steps):
                t = self.train_step(p, step, t)
            t = self.sync(p, g, t, 7, "cudaDeviceSynchronize")
            last_end = max(last_end, t)

        # background threads: data loaders, event handler, NCCL proxy
        for p in procs:
            for i, g in enumerate(p["loader"]):
                t = t_begin + self.jitter(500)
                while t < last_end:
                    t = self.osrt(g, "read", t, self.jitter(rng.choice([80, 140, 900])))
                    t = self.osrt(g, "pthread_cond_wait", t, self.jitter(rng.choice([2500, 6000, 15000])))
                    t = self.osrt(g, "pthread_mutex_lock", t, self.jitter(1.5))
                    t += self.jitter(40)
            t = t_begin + self.jitter(200)
            while t < last_end:
                t = self.osrt(p["evt"], "poll", t, self.jitter(rng.choice([10000, 25000, 50000])))
                t = self.osrt(p["evt"], "ioctl", t, self.jitter(8))
            t = t_begin + self.jitter(250)
            while t < last_end:
                t = self.osrt(p["nccl"], "pthread_cond_timedwait", t, self.jitter(rng.choice([800, 4000])))
                t += self.jitter(30)
                t = self.osrt(p["nccl"], "sendmsg", t, self.jitter(6))

        self.gpu_metrics(t_begin, last_end)
        self.t_end = last_end + 20 * MS

    def layer(self, p, g, t, fwd):
        stream = 7
        if fwd:
            t = self.launch(p, g, t, "layer_norm", stream)
            t = self.launch(p, g, t + self.jitter(6), "gemm", stream)
            t = self.launch(p, g, t + self.jitter(4), "flash_fwd", stream)
            t = self.launch(p, g, t + self.jitter(4), "gemm", stream, 0.33)
            t = self.launch(p, g, t + self.jitter(3), "add", stream)
            t = self.launch(p, g, t + self.jitter(5), "layer_norm", stream)
            t = self.launch(p, g, t + self.jitter(4), "gemm", stream, 1.3)
            t = self.launch(p, g, t + self.jitter(3), "gelu", stream)
            t = self.launch(p, g, t + self.jitter(4), "gemm", stream, 1.3)
            t = self.launch(p, g, t + self.jitter(3), "add", stream)
        else:
            t = self.launch(p, g, t, "gemm_bwd", stream, 1.1)
            t = self.launch(p, g, t + self.jitter(3), "gelu", stream, 1.4)
            t = self.launch(p, g, t + self.jitter(4), "gemm_bwd", stream, 1.1)
            t = self.launch(p, g, t + self.jitter(4), "layer_norm_bwd", stream)
            t = self.launch(p, g, t + self.jitter(4), "gemm_bwd", stream, 0.4)
            t = self.launch(p, g, t + self.jitter(3), "flash_bwd", stream)
            t = self.launch(p, g, t + self.jitter(4), "gemm_bwd", stream)
            t = self.launch(p, g, t + self.jitter(3), "layer_norm_bwd", stream)
            t = self.launch(p, g, t + self.jitter(3), "reduce", stream)
        return t

    def train_step(self, p, step, t0):
        rng = self.rng
        g = p["main"]
        ga = p["autograd"]
        t = t0
        step_name = "train_step"
        # data loading
        t1 = t
        t = self.osrt(g, "pthread_cond_wait", t, self.jitter(rng.choice([300, 600, 4500 if step % 7 == 3 else 500])))
        t = self.memcpy(p, g, t, 1, 16 * 1024 * 1024, 15, "cudaMemcpyAsync", 2, 3)
        t = self.memcpy(p, g, t + self.jitter(5), 1, 2 * 1024 * 1024, 15, "cudaMemcpyAsync", 2, 3)
        t = self.api(g, "cudaEventRecord", t, self.jitter(3), self.next_corr())
        t = self.api(g, "cudaStreamWaitEvent", t, self.jitter(2), self.next_corr())
        self.stream_free[(p["dev"], 7)] = max(self.stream_free.get((p["dev"], 7), 0), self.stream_free.get((p["dev"], 15), 0))
        self.nvtx_range(g, "data_loading", t1, t, color=NVTX_COLORS["data_loading"])

        # forward
        tf = t
        t = self.launch(p, g, t + self.jitter(10), "embedding", 7)
        for li in range(self.layers):
            tl = t
            t = self.layer(p, g, t + self.jitter(8), True)
            self.nvtx_range(g, f"TransformerBlock[{li}].forward", tl, t + self.jitter(2))
            t += self.jitter(4)
        t = self.launch(p, g, t + self.jitter(10), "gemm", 7, 2.0)
        t = self.launch(p, g, t + self.jitter(5), "softmax_ce", 7)
        t = self.launch(p, g, t + self.jitter(5), "reduce", 7)
        self.nvtx_range(g, "forward", tf, t, color=NVTX_COLORS["forward"])

        # backward runs on the autograd thread while the main thread waits
        tb0 = t + self.jitter(20)
        tb = tb0
        t_main_wait_start = t + self.jitter(8)
        bucket_every = max(1, self.layers // 4)
        nccl_launches = []
        for li in reversed(range(self.layers)):
            tl = tb
            tb = self.layer(p, ga, tb + self.jitter(6), False)
            self.nvtx_range(ga, f"TransformerBlock[{li}].backward", tl, tb + self.jitter(2))
            if li % bucket_every == 0:
                nccl_launches.append(tb)
            tb += self.jitter(4)
        self.nvtx_range(ga, "backward", tb0, tb, color=NVTX_COLORS["backward"])

        # gradient all-reduce on NCCL stream (overlaps with backward)
        for tn in nccl_launches:
            self.stream_free[(p["dev"], 13)] = max(self.stream_free.get((p["dev"], 13), 0),
                                                   self.stream_free.get((p["dev"], 7), 0) - 400 * US)
            ts = tn + self.jitter(3)
            te = self.launch(p, ga, ts, "nccl", 13)
            self.nvtx_range(ga, "ncclAllReduce", ts - self.jitter(2), te + self.jitter(1), domain=1,
                            color=NVTX_COLORS["allreduce"])
        t = self.sync(p, g, max(t_main_wait_start, tb), 13, "cudaStreamSynchronize")
        self.osrt(g, "pthread_cond_wait", t_main_wait_start, max(1000, tb - t_main_wait_start - 2000))

        # optimizer
        to = t + self.jitter(15)
        t = to
        for _ in range(4):
            t = self.memset(p, g, t, 4 * 1024 * 1024, 7)
            t = self.launch(p, g, t + self.jitter(5), "adam", 7)
        self.nvtx_range(g, "optimizer_step", to, t, color=NVTX_COLORS["optimizer_step"])

        # loss.item() → D2H copy, blocking
        t = self.memcpy(p, g, t + self.jitter(10), 2, 4, 7, "cudaMemcpy", 3, 1)
        if step % 5 == 0:
            self.nvtx_mark(g, f"checkpoint step {step}", t)
        self.rows["overhead"].append((t, t + self.jitter(30), g, None, self.sid("CUDA profiling data flush")))
        self.nvtx_range(g, f"{step_name} #{step}", t0, t + self.jitter(5), color=NVTX_COLORS["train_step"])
        return t + self.jitter(60)

    def gpu_metrics(self, t0, t1):
        metrics = ["GPC Clock Frequency [MHz]", "SMs Active [Throughput %]", "SM Issue [Throughput %]",
                   "Tensor Active [Throughput %]", "DRAM Read Bandwidth [Throughput %]",
                   "DRAM Write Bandwidth [Throughput %]", "PCIe RX Throughput [Throughput %]"]
        self.metric_names = metrics
        period = 1 * MS
        kern_by_dev = {0: [], 1: []}
        for r in self.rows["kernel"]:
            kern_by_dev[r[2]].append((r[0], r[1], r[9]))
        for dev in (0, 1):
            ks = sorted(kern_by_dev[dev])
            idx = 0
            t = t0 - 50 * MS
            while t < t1 + 20 * MS:
                busy = 0
                tensor = 0
                while idx < len(ks) and ks[idx][1] < t:
                    idx += 1
                j = idx
                while j < len(ks) and ks[j][0] < t + period:
                    ov = min(ks[j][1], t + period) - max(ks[j][0], t)
                    if ov > 0:
                        busy += ov
                        name = self.str_by_id(ks[j][2])
                        if "gemm" in name or "flash" in name:
                            tensor += ov
                    j += 1
                frac = min(1.0, busy / period)
                tfrac = min(1.0, tensor / period)
                vals = [
                    1980 if frac > 0.05 else 1410,
                    int(100 * frac * self.rng.uniform(0.85, 0.98)),
                    int(100 * frac * self.rng.uniform(0.35, 0.6)),
                    int(100 * tfrac * self.rng.uniform(0.55, 0.8)),
                    int(100 * frac * self.rng.uniform(0.15, 0.45)),
                    int(100 * frac * self.rng.uniform(0.08, 0.3)),
                    int(self.rng.uniform(0, 4) + (30 if frac < 0.2 and frac > 0 else 0)),
                ]
                for mid, v in enumerate(vals):
                    self.rows["metrics"].append((dev, t, mid, v))
                t += period

    def str_by_id(self, i):
        if not hasattr(self, "_rev"):
            self._rev = {}
        if len(self._rev) != len(self.strings):
            self._rev = {v: k for k, v in self.strings.items()}
        return self._rev[i]

    def write(self, path):
        if os.path.exists(path):
            os.remove(path)
        db = sqlite3.connect(path)
        db.executescript(SCHEMA)
        c = db.cursor()
        # NVTX domain create events (domain 1 = NCCL)
        self.rows["nvtx"].append((self.t_end // 2, None, 75, None, None, None, "NCCL", None, None, None, 1,
                                  None, None, None, None, None, None, None, None))
        names = {
            "main": "python3", "autograd": "pt_autograd_0", "evt": "cuda-EvtHandlr", "nccl": "NCCL Proxy",
        }
        for p in self.procs:
            c.execute("INSERT INTO PROCESSES VALUES (?,?,?)", (p["gpid"], p["pid"], "python3"))
            for key, nm in names.items():
                c.execute("INSERT INTO ThreadNames VALUES (?,?,?)", (self.sid(nm), 0, p[key]))
            for i, g in enumerate(p["loader"]):
                c.execute("INSERT INTO ThreadNames VALUES (?,?,?)", (self.sid(f"pt_data_worker_{i}"), 0, g))
            for s, prio in ((7, 0), (13, -1), (15, 0)):
                c.execute("INSERT INTO TARGET_INFO_CUDA_STREAM VALUES (?,?,?,?,?,?,?)", (s, s, 0, p["pid"], 1, prio, 1))
        for dev in (0, 1):
            c.execute("INSERT INTO TARGET_INFO_GPU VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                      (0, dev, "NVIDIA H100 80GB HBM3", f"0000:{0x18 + dev * 0x1c:02x}:00.0", 1, 52428800,
                       85520809984, 3352320000000, 1980000, 132, dev, f"GPU-5f1c3c2a-{dev:04d}", 0, "GH100"))
            c.execute("INSERT INTO TARGET_INFO_CUDA_DEVICE VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                      (dev, dev, self.procs[dev]["pid"], f"GPU-5f1c3c2a-{dev:04d}", 132, 9, 0, 64, 32, 65536, 49152,
                       "NVIDIA H100 80GB HBM3"))
            for mid, mname in enumerate(self.metric_names):
                c.execute("INSERT INTO TARGET_INFO_GPU_METRICS VALUES (?,?,?,?,?)",
                          (dev, dev, f"GH100 (GPU {dev})", mid, mname))
        c.executemany("INSERT INTO ENUM_CUDA_MEMCPY_OPER VALUES (?,?,?)", MEMCPY_KINDS)
        c.executemany("INSERT INTO ENUM_CUDA_MEM_KIND VALUES (?,?,?)", MEM_KINDS)
        c.executemany("INSERT INTO ENUM_NSYS_EVENT_TYPE VALUES (?,?,?)", [
            (33, "NvtxCategory", "NVTX Category"), (34, "NvtxMark", "NVTX Mark"),
            (59, "NvtxPushPopRange", "NVTX PushPop Range"), (60, "NvtxStartEndRange", "NVTX StartEnd Range"),
            (75, "NvtxDomainCreate", "NVTX Domain Create")])
        c.executemany("INSERT INTO META_DATA_EXPORT VALUES (?,?)", [
            ("EXPORT_SCHEMA_VERSION", "3.11.2"), ("EXPORT_PRODUCT", "Synthetic sample (nsys-web-viewer)")])
        c.executemany("INSERT INTO META_DATA_CAPTURE VALUES (?,?)", [("NSYS_VERSION", "2025.5.1 (synthetic)")])
        c.execute("INSERT INTO ANALYSIS_DETAILS VALUES (?,?,?,?)", (0, self.t_end, 0, self.t_end))
        c.execute("INSERT INTO TARGET_INFO_SESSION_START_TIME VALUES (?,?,?)",
                  (1764093000000000000, "2025-11-25 17:50:00", "2025-11-25 17:50:00"))
        c.executemany("INSERT INTO TARGET_INFO_SYSTEM_ENV VALUES (?,?,?,?,?)", [
            (0, "Host", "Hostname", 1, "gpu-node-07"), (0, "Host", "OS", 2, "Ubuntu 22.04.4 LTS"),
            (0, "Host", "CpuName", 3, "Intel(R) Xeon(R) Platinum 8480+"), (0, "Host", "CpuCores", 4, "112")])

        c.executemany("INSERT INTO CUPTI_ACTIVITY_KIND_KERNEL VALUES (" + ",".join("?" * 28) + ")", self.rows["kernel"])
        c.executemany("INSERT INTO CUPTI_ACTIVITY_KIND_MEMCPY VALUES (" + ",".join("?" * 20) + ")", self.rows["memcpy"])
        c.executemany("INSERT INTO CUPTI_ACTIVITY_KIND_MEMSET VALUES (" + ",".join("?" * 12) + ")", self.rows["memset"])
        c.executemany("INSERT INTO CUPTI_ACTIVITY_KIND_RUNTIME VALUES (?,?,?,?,?,?,?,?)", self.rows["runtime"])
        c.executemany("INSERT INTO NVTX_EVENTS VALUES (" + ",".join("?" * 19) + ")", self.rows["nvtx"])
        c.executemany("INSERT INTO OSRT_API VALUES (?,?,?,?,?,?,?,?,?)", self.rows["osrt"])
        c.executemany("INSERT INTO CUBLAS_EVENTS VALUES (?,?,?,?,?)", self.rows["cublas"])
        c.executemany("INSERT INTO PROFILER_OVERHEAD VALUES (?,?,?,?,?)", self.rows["overhead"])
        c.executemany("INSERT INTO GPU_METRICS VALUES (?,?,?,?)", self.rows["metrics"])
        c.executemany("INSERT INTO StringIds VALUES (?,?)", [(v, k) for k, v in self.strings.items()])
        db.commit()
        db.execute("VACUUM")
        db.close()
        total = sum(len(v) for v in self.rows.values())
        print(f"wrote {path}: {total:,} rows "
              + ", ".join(f"{k}={len(v):,}" for k, v in self.rows.items())
              + f", {os.path.getsize(path) / 1e6:.1f} MB")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="public/sample.sqlite")
    ap.add_argument("--steps", type=int, default=8)
    ap.add_argument("--layers", type=int, default=12)
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    g = Gen(a.seed, a.steps, a.layers)
    g.build()
    g.write(a.out)


if __name__ == "__main__":
    main()
