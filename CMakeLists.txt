cmake_minimum_required(VERSION 3.16)
project(autoremesher-wasm CXX C)

# Build with the Emscripten toolchain:
#   emcmake cmake -B build -DCMAKE_BUILD_TYPE=Release
#   cmake --build build -j
# Outputs wasm/autoremesher.mjs + wasm/autoremesher.wasm

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

set(AR_ROOT ${CMAKE_CURRENT_SOURCE_DIR}/cpp/autoremesher)
set(GEOGRAM_ROOT ${AR_ROOT}/thirdparty/geogram/geogram-1.8.3/src/lib)

set(AUTOREMESHER_CORE_SOURCES
    # autoremesher.cpp is overridden: upstream's sleep-based progress
    # spinlock stalls the pthreads build (see emscripten/overrides/).
    ${CMAKE_CURRENT_SOURCE_DIR}/emscripten/overrides/autoremesher_core.cpp
    ${AR_ROOT}/src/AutoRemesher/isotropicremesher.cpp
    ${AR_ROOT}/src/AutoRemesher/parameterizer.cpp
    ${AR_ROOT}/src/AutoRemesher/quadextractor.cpp
    ${AR_ROOT}/src/AutoRemesher/positionkey.cpp
    ${AR_ROOT}/src/AutoRemesher/meshseparator.cpp
    ${AR_ROOT}/src/AutoRemesher/nl_ext_stubs.c
    ${AR_ROOT}/thirdparty/isotropicremesher/isotropicremesher.cpp
    ${AR_ROOT}/thirdparty/isotropicremesher/isotropichalfedgemesh.cpp
    ${AR_ROOT}/thirdparty/isotropicremesher/axisalignedboundingboxtree.cpp
)

# Geogram subset: exactly the sources the upstream autoremesher.pro compiles.
set(GEOGRAM_SOURCES
    ${GEOGRAM_ROOT}/geogram/basic/algorithm.cpp
    ${GEOGRAM_ROOT}/geogram/basic/assert.cpp
    ${GEOGRAM_ROOT}/geogram/basic/attributes.cpp
    ${GEOGRAM_ROOT}/geogram/basic/b_stream.cpp
    ${GEOGRAM_ROOT}/geogram/basic/command_line.cpp
    ${GEOGRAM_ROOT}/geogram/basic/command_line_args.cpp
    # common.cpp is overridden: upstream's EM_ASM NODEFS mount crashes
    # under ES-module output (see emscripten/overrides/geogram_common.cpp).
    ${CMAKE_CURRENT_SOURCE_DIR}/emscripten/overrides/geogram_common.cpp
    ${GEOGRAM_ROOT}/geogram/basic/counted.cpp
    ${GEOGRAM_ROOT}/geogram/basic/environment.cpp
    ${GEOGRAM_ROOT}/geogram/basic/factory.cpp
    ${GEOGRAM_ROOT}/geogram/basic/file_system.cpp
    ${GEOGRAM_ROOT}/geogram/basic/geofile.cpp
    ${GEOGRAM_ROOT}/geogram/basic/geometry.cpp
    ${GEOGRAM_ROOT}/geogram/basic/line_stream.cpp
    ${GEOGRAM_ROOT}/geogram/basic/logger.cpp
    ${GEOGRAM_ROOT}/geogram/basic/numeric.cpp
    ${GEOGRAM_ROOT}/geogram/basic/packed_arrays.cpp
    ${GEOGRAM_ROOT}/geogram/basic/process.cpp
    ${GEOGRAM_ROOT}/geogram/basic/process_unix.cpp
    ${GEOGRAM_ROOT}/geogram/basic/process_win.cpp
    ${GEOGRAM_ROOT}/geogram/basic/progress.cpp
    ${GEOGRAM_ROOT}/geogram/basic/quaternion.cpp
    ${GEOGRAM_ROOT}/geogram/basic/stopwatch.cpp
    ${GEOGRAM_ROOT}/geogram/basic/string.cpp
    ${GEOGRAM_ROOT}/geogram/bibliography/bibliography.cpp
    ${GEOGRAM_ROOT}/geogram/bibliography/embedded_references.cpp
    ${GEOGRAM_ROOT}/geogram/delaunay/LFS.cpp
    ${GEOGRAM_ROOT}/geogram/delaunay/delaunay.cpp
    ${GEOGRAM_ROOT}/geogram/delaunay/delaunay_2d.cpp
    ${GEOGRAM_ROOT}/geogram/delaunay/delaunay_3d.cpp
    ${GEOGRAM_ROOT}/geogram/delaunay/delaunay_nn.cpp
    ${GEOGRAM_ROOT}/geogram/delaunay/delaunay_tetgen.cpp
    ${GEOGRAM_ROOT}/geogram/delaunay/delaunay_triangle.cpp
    ${GEOGRAM_ROOT}/geogram/delaunay/parallel_delaunay_3d.cpp
    ${GEOGRAM_ROOT}/geogram/delaunay/periodic.cpp
    ${GEOGRAM_ROOT}/geogram/delaunay/periodic_delaunay_3d.cpp
    ${GEOGRAM_ROOT}/geogram/image/colormap.cpp
    ${GEOGRAM_ROOT}/geogram/image/image.cpp
    ${GEOGRAM_ROOT}/geogram/image/image_library.cpp
    ${GEOGRAM_ROOT}/geogram/image/image_rasterizer.cpp
    ${GEOGRAM_ROOT}/geogram/image/image_serializer.cpp
    ${GEOGRAM_ROOT}/geogram/image/image_serializer_pgm.cpp
    ${GEOGRAM_ROOT}/geogram/image/image_serializer_stb.cpp
    ${GEOGRAM_ROOT}/geogram/image/image_serializer_xpm.cpp
    ${GEOGRAM_ROOT}/geogram/image/morpho_math.cpp
    ${GEOGRAM_ROOT}/geogram/mesh/mesh.cpp
    ${GEOGRAM_ROOT}/geogram/mesh/mesh_AABB.cpp
    ${GEOGRAM_ROOT}/geogram/mesh/mesh_fill_holes.cpp
    ${GEOGRAM_ROOT}/geogram/mesh/mesh_frame_field.cpp
    ${GEOGRAM_ROOT}/geogram/mesh/mesh_geometry.cpp
    ${GEOGRAM_ROOT}/geogram/mesh/mesh_halfedges.cpp
    ${GEOGRAM_ROOT}/geogram/mesh/mesh_io.cpp
    ${GEOGRAM_ROOT}/geogram/mesh/mesh_partition.cpp
    ${GEOGRAM_ROOT}/geogram/mesh/mesh_preprocessing.cpp
    ${GEOGRAM_ROOT}/geogram/mesh/mesh_reorder.cpp
    ${GEOGRAM_ROOT}/geogram/mesh/mesh_repair.cpp
    ${GEOGRAM_ROOT}/geogram/mesh/mesh_topology.cpp
    ${GEOGRAM_ROOT}/geogram/numerics/expansion_nt.cpp
    ${GEOGRAM_ROOT}/geogram/numerics/lbfgs_optimizers.cpp
    ${GEOGRAM_ROOT}/geogram/numerics/matrix_util.cpp
    ${GEOGRAM_ROOT}/geogram/numerics/multi_precision.cpp
    ${GEOGRAM_ROOT}/geogram/numerics/optimizer.cpp
    ${GEOGRAM_ROOT}/geogram/numerics/predicates.cpp
    ${GEOGRAM_ROOT}/geogram/parameterization/mesh_global_param.cpp
    ${GEOGRAM_ROOT}/geogram/points/co3ne.cpp
    ${GEOGRAM_ROOT}/geogram/points/colocate.cpp
    ${GEOGRAM_ROOT}/geogram/points/kd_tree.cpp
    ${GEOGRAM_ROOT}/geogram/points/nn_search.cpp
    ${GEOGRAM_ROOT}/geogram/points/principal_axes.cpp
    ${GEOGRAM_ROOT}/geogram/voronoi/CVT.cpp
    ${GEOGRAM_ROOT}/geogram/voronoi/RVD.cpp
    ${GEOGRAM_ROOT}/geogram/voronoi/RVD_callback.cpp
    ${GEOGRAM_ROOT}/geogram/voronoi/RVD_mesh_builder.cpp
    ${GEOGRAM_ROOT}/geogram/voronoi/convex_cell.cpp
    ${GEOGRAM_ROOT}/geogram/voronoi/generic_RVD_cell.cpp
    ${GEOGRAM_ROOT}/geogram/voronoi/generic_RVD_polygon.cpp
    ${GEOGRAM_ROOT}/geogram/voronoi/integration_simplex.cpp
    ${GEOGRAM_ROOT}/exploragram/hexdom/basic.cpp
    ${GEOGRAM_ROOT}/exploragram/hexdom/frame.cpp
    ${GEOGRAM_ROOT}/exploragram/hexdom/spherical_harmonics_l4.cpp
    ${GEOGRAM_ROOT}/exploragram/hexdom/polygon.cpp
    ${GEOGRAM_ROOT}/exploragram/hexdom/quad_cover.cpp
    ${GEOGRAM_ROOT}/geogram/NL/nl_api.c
    ${GEOGRAM_ROOT}/geogram/NL/nl_matrix.c
    ${GEOGRAM_ROOT}/geogram/NL/nl_context.c
    ${GEOGRAM_ROOT}/geogram/NL/nl_blas.c
    ${GEOGRAM_ROOT}/geogram/NL/nl_arpack.c
    ${GEOGRAM_ROOT}/geogram/NL/nl_iterative_solvers.c
    ${GEOGRAM_ROOT}/geogram/NL/nl_preconditioners.c
    ${GEOGRAM_ROOT}/geogram/NL/nl_os.c
    ${GEOGRAM_ROOT}/geogram/third_party/libMeshb/sources/libmeshb7.c
    ${GEOGRAM_ROOT}/geogram/third_party/rply/rply.c
    ${GEOGRAM_ROOT}/geogram/third_party/zlib/adler32.c
    ${GEOGRAM_ROOT}/geogram/third_party/zlib/compress.c
    ${GEOGRAM_ROOT}/geogram/third_party/zlib/crc32.c
    ${GEOGRAM_ROOT}/geogram/third_party/zlib/deflate.c
    ${GEOGRAM_ROOT}/geogram/third_party/zlib/gzclose.c
    ${GEOGRAM_ROOT}/geogram/third_party/zlib/gzlib.c
    ${GEOGRAM_ROOT}/geogram/third_party/zlib/gzread.c
    ${GEOGRAM_ROOT}/geogram/third_party/zlib/gzwrite.c
    ${GEOGRAM_ROOT}/geogram/third_party/zlib/inffast.c
    ${GEOGRAM_ROOT}/geogram/third_party/zlib/inflate.c
    ${GEOGRAM_ROOT}/geogram/third_party/zlib/inftrees.c
    ${GEOGRAM_ROOT}/geogram/third_party/zlib/trees.c
    ${GEOGRAM_ROOT}/geogram/third_party/zlib/uncompr.c
    ${GEOGRAM_ROOT}/geogram/third_party/zlib/zutil.c
)

# Two variants from the same sources:
#   autoremesher     single-threaded (works everywhere)
#   autoremesher_mt  pthreads build (needs SharedArrayBuffer; in
#                    browsers that means cross-origin isolation)
function(add_autoremesher_variant TARGET OUTPUT_BASENAME THREADED)
    add_executable(${TARGET}
        ${AUTOREMESHER_CORE_SOURCES}
        ${GEOGRAM_SOURCES}
        ${CMAKE_CURRENT_SOURCE_DIR}/emscripten/bindings.cpp
    )

    target_include_directories(${TARGET} BEFORE PRIVATE
        ${CMAKE_CURRENT_SOURCE_DIR}/emscripten/tbb-shim
        ${CMAKE_CURRENT_SOURCE_DIR}/emscripten/qt-shim
    )

    target_include_directories(${TARGET} PRIVATE
        ${AR_ROOT}/include
        ${AR_ROOT}/thirdparty/eigen
        ${AR_ROOT}/thirdparty/geogram
        ${GEOGRAM_ROOT}
        ${GEOGRAM_ROOT}/geogram/NL
        ${GEOGRAM_ROOT}/geogram/third_party/libMeshb/sources
        ${GEOGRAM_ROOT}/geogram/third_party/zlib
        ${AR_ROOT}/thirdparty/isotropicremesher
    )

    target_compile_definitions(${TARGET} PRIVATE
        _USE_MATH_DEFINES
        NOMINMAX
        $<$<CONFIG:Release>:NDEBUG>
    )

    if(EMSCRIPTEN)
        # Native WASM exception handling: needed because geogram and the
        # binding layer rely on C++ exceptions for error reporting.
        target_compile_options(${TARGET} PRIVATE
            -fwasm-exceptions -O3
            "$<$<COMPILE_LANGUAGE:CXX>:SHELL:-include ${CMAKE_CURRENT_SOURCE_DIR}/emscripten/compat/wasm_compat.h>"
        )

        set(VARIANT_LINK_FLAGS
            "-fwasm-exceptions"
            "-O3"
            "-sMODULARIZE=1"
            "-sEXPORT_ES6=1"
            "-sEXPORT_NAME=createAutoRemesher"
            "-sENVIRONMENT=web,worker,node"
            "-sALLOW_MEMORY_GROWTH=1"
            "-sMAXIMUM_MEMORY=4GB"
            "-sSTACK_SIZE=8388608"
            "-sEXPORTED_FUNCTIONS=_ar_remesh,_ar_get_vertices,_ar_get_vertex_count,_ar_get_quads,_ar_get_quad_count,_ar_get_error,_ar_release,_ar_malloc,_ar_free"
            "-sEXPORTED_RUNTIME_METHODS=cwrap,ccall,UTF8ToString,HEAPF32,HEAPU32,HEAPU8"
            "-sINCOMING_MODULE_JS_API=onRemeshProgress,locateFile,wasmBinary,print,printErr"
        )

        if(THREADED)
            target_compile_options(${TARGET} PRIVATE -pthread)
            list(APPEND VARIANT_LINK_FLAGS
                "-pthread"
                # Pre-spawn workers so pthread_create never blocks the
                # calling thread waiting for a worker to boot.
                "SHELL:-s PTHREAD_POOL_SIZE='(globalThis.navigator&&navigator.hardwareConcurrency)||4'"
                "-sPTHREAD_POOL_SIZE_STRICT=0"
                # The default dlmalloc takes a global lock per
                # allocation; this code allocates heavily from all
                # island threads at once.
                "-sMALLOC=mimalloc"
            )
        endif()

        target_link_options(${TARGET} PRIVATE ${VARIANT_LINK_FLAGS})

        set_target_properties(${TARGET} PROPERTIES
            OUTPUT_NAME ${OUTPUT_BASENAME}
            SUFFIX ".mjs"
            RUNTIME_OUTPUT_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/wasm
        )
    endif()
endfunction()

add_autoremesher_variant(autoremesher autoremesher FALSE)
add_autoremesher_variant(autoremesher_mt autoremesher-mt TRUE)
