from pathlib import Path
import copy
import pytest
from vidmyo_repurpose import vfx
from vidmyo_repurpose.vfx import validate_spec, validate_shots
ENGINE = Path(__file__).resolve().parents[2] / 'vfx-engine'

def fixture():
    src={'file':'/tmp/source.mp4','durationSec':4,'width':640,'height':360,'fps':30,'frameCount':120}
    intake={'source':src,'shots':[{'startSec':0,'endSec':4,'shot':'talking-head'}],'reviewed':True}
    m={'name':'Test','segmentType':'intro','brand':{'theme':'simple-claude'},'brief':''}
    spec={'version':1,'meta':{'project':'untrusted','run':'untrusted','segmentType':'intro'},'source':src,'brand':{'theme':'synthwave'},'events':[{'id':'evt-01','move':'CONCEPT_GRAPHIC','tier':'content','startSec':1,'endSec':3,'anchor':{'transcript':'Better visual stories','shot':'talking-head'},'payload':{'variant':'split-screen','kind':'statement','text':'BETTER VISUAL STORIES'}}]}
    return spec,intake,m

def test_valid_spec_uses_host_source_and_brand():
    s,i,m=fixture();s['source']={**s['source'],'file':'/tmp/attacker.mp4'}
    result=validate_spec(s,i,m,ENGINE)
    assert result['source']['file']=='/tmp/source.mp4'
    assert result['brand']==m['brand']

@pytest.mark.parametrize('shot',['screen-share','b-roll'])
def test_docking_rejected_for_wrong_shots(shot):
    s,i,m=fixture();i['shots'][0]['shot']=shot
    with pytest.raises(ValueError,match='Docking'):validate_spec(s,i,m,ENGINE)

def test_class_change_midhold_cannot_be_docked():
    s,i,m=fixture();i['shots']=[{'startSec':0,'endSec':2,'shot':'talking-head'},{'startSec':2,'endSec':4,'shot':'screen-share'}]
    with pytest.raises(ValueError,match='Docking'):validate_spec(s,i,m,ENGINE)

@pytest.mark.parametrize('change', ['nan','overlap','cut','unreviewed','unsupported-overlay','false-anchor'])
def test_invalid_plan_rejected(change):
    s,i,m=fixture();transcript=None
    if change=='nan':s['events'][0]['endSec']=float('nan')
    elif change=='overlap':s['events'].append(copy.deepcopy(s['events'][0]))
    elif change=='cut':i['shots']=[{'startSec':0,'endSec':1.2,'shot':'talking-head'},{'startSec':1.2,'endSec':4,'shot':'talking-head'}]
    elif change=='unreviewed':i['reviewed']=False
    elif change=='unsupported-overlay':s['events'][0]['payload'].update(variant='overlay',kind='steps')
    elif change=='false-anchor':transcript={'words':[{'text':'unrelated'}]}
    with pytest.raises(ValueError):validate_spec(s,i,m,ENGINE,transcript)

def test_outro_safe_zone_is_enforced():
    s,i,m=fixture();m['brief']='An outro'
    with pytest.raises(ValueError,match='endscreen'):validate_spec(s,i,m,ENGINE)
    s['events'][0]['payload'].update(variant='overlay',zone='top',endscreenSafe=True)
    validate_spec(s,i,m,ENGINE)

def test_shots_cannot_hide_source_intervals():
    _,i,_=fixture();i['shots'][0]['endSec']=3
    with pytest.raises(ValueError,match='whole section'):validate_shots(i['shots'],i['source'])

@pytest.mark.parametrize('dimensions', [(3840,2160),(2160,3840),(4096,2160),(7680,4320)])
def test_spec_preserves_native_dimensions_above_full_hd(dimensions):
    s,i,m=fixture()
    i['source'].update(width=dimensions[0],height=dimensions[1])
    result=validate_spec(s,i,m,ENGINE)
    assert (result['source']['width'],result['source']['height'])==dimensions

def test_portrait_gets_short_form_profile_and_subject_safe_split():
    s,i,m=fixture();i['source'].update(width=1080,height=1920)
    result=validate_spec(s,i,m,ENGINE)
    assert result['meta']['format']['canvasClass']=='portrait'
    assert result['meta']['format']['platform']=='shorts'
    assert 'full-bleed' in result['events'][0]['payload']['layoutNotes']

def test_portrait_diagram_is_promoted_to_vertical_full_screen():
    s,i,m=fixture();i['source'].update(width=1080,height=1920);i['shots'][0]['shot']='screen-share'
    s['events'][0]['anchor']['shot']='screen-share'
    s['events'][0]['payload']={
        'variant':'75-split','kind':'steps','title':'Three clear steps',
        'items':[{'text':'First'},{'text':'Second'},{'text':'Third'}],
    }
    result=validate_spec(s,i,m,ENGINE)
    payload=result['events'][0]['payload']
    assert payload['variant']=='full-screen'
    assert 'vertically stacked' in payload['layoutNotes']

def test_landscape_keeps_requested_docking_layout():
    s,i,m=fixture();s['events'][0]['payload']['variant']='75-split'
    result=validate_spec(s,i,m,ENGINE)
    assert result['meta']['format']['canvasClass']=='landscape'
    assert result['events'][0]['payload']['variant']=='75-split'

def test_portrait_bottom_stage_rejects_overloaded_diagram():
    s,i,m=fixture();i['source'].update(width=1080,height=1920)
    s['events'][0]['payload']={'variant':'split-screen','kind':'list','items':[{'text':f'Item {n}'} for n in range(4)]}
    with pytest.raises(ValueError,match='bottom-stage'):
        validate_spec(s,i,m,ENGINE)

def test_phone_rotation_is_baked_into_project_copy(tmp_path, monkeypatch):
    source=tmp_path/'phone.mov';source.write_bytes(b'phone')
    video={'codec_type':'video','avg_frame_rate':'30/1','side_data_list':[{'rotation':90}]}
    monkeypatch.setattr(vfx,'_probe_document',lambda _:({'streams':[video]},video))
    calls=[]
    def run(command,**kwargs):
        calls.append(command)
        Path(command[-1]).write_bytes(b'upright')
    monkeypatch.setattr(vfx.subprocess,'run',run)
    monkeypatch.setattr(vfx,'probe',lambda target:{'file':str(Path(target).resolve()),'width':360,'height':640})
    result=vfx.normalize(tmp_path/'project',source)
    assert result['normalized'] is True and result['rotation']==90
    assert result['file'].endswith('source-upright.mov')
    assert calls[0][calls[0].index('-vf')+1]=='setsar=1,format=yuv420p'
    assert calls[0][calls[0].index('-c:a')+1]=='copy'

def test_unrotated_source_is_used_without_copy(tmp_path, monkeypatch):
    source=tmp_path/'ready.mp4';source.write_bytes(b'ready')
    video={'codec_type':'video','side_data_list':[]}
    monkeypatch.setattr(vfx,'_probe_document',lambda _:({'streams':[video]},video))
    result=vfx.normalize(tmp_path/'project',source)
    assert result=={'file':str(source.resolve()),'normalized':False,'rotation':0}
    assert not (tmp_path/'project').exists()
